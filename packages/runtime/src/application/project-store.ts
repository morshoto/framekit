import { mkdir as nodeMkdir, readFile as nodeReadFile, rename as nodeRename, unlink as nodeUnlink, writeFile as nodeWriteFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ContextRevision } from "../domain/primitives.js";
import { validateTimelineIr, type TimelineIr } from "../timeline/editing-session.js";

export const FRAMEKIT_PROJECT_SCHEMA_VERSION = 1 as const;

export interface FramekitProjectMetadata {
  createdAt: string;
  updatedAt: string;
}

/** The persisted envelope owns metadata; the Timeline IR remains the canonical model. */
export interface FramekitProjectDocument {
  schemaVersion: typeof FRAMEKIT_PROJECT_SCHEMA_VERSION;
  metadata: FramekitProjectMetadata;
  timeline: TimelineIr;
}

export interface ProjectStoreFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, options: { encoding: "utf8"; flag: "wx" }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export type ProjectPersistenceErrorCode =
  | "PROJECT_NOT_FOUND"
  | "PROJECT_ALREADY_EXISTS"
  | "PROJECT_INVALID"
  | "PROJECT_CORRUPT"
  | "PROJECT_SCHEMA_UNSUPPORTED"
  | "PROJECT_STALE_REVISION"
  | "PROJECT_SAVE_FAILED";

export class ProjectPersistenceError extends Error {
  public readonly code: ProjectPersistenceErrorCode;
  public readonly details?: Readonly<Record<string, unknown>>;

  public constructor(
    code: ProjectPersistenceErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "ProjectPersistenceError";
    this.code = code;
    this.details = details;
  }
}

export interface FramekitProjectMigration {
  fromSchemaVersion: number;
  toSchemaVersion: number;
  migrate(input: unknown): unknown;
}

const fileSystem: ProjectStoreFileSystem = {
  mkdir: async (path, options) => { await nodeMkdir(path, options); },
  readFile: async (path, encoding) => nodeReadFile(path, encoding),
  writeFile: async (path, data, options) => { await nodeWriteFile(path, data, options); },
  rename: async (from, to) => { await nodeRename(from, to); },
  unlink: async (path) => { await nodeUnlink(path); },
};

export class FramekitProjectStore {
  public constructor(
    private readonly path: string,
    private readonly fs: ProjectStoreFileSystem = fileSystem,
  ) {}

  public async create(project: FramekitProjectDocument): Promise<FramekitProjectDocument> {
    return this.withProjectLock(async () => {
      try {
        await this.fs.readFile(this.path, "utf8");
        throw new ProjectPersistenceError("PROJECT_ALREADY_EXISTS", `project file already exists: ${this.path}`);
      } catch (error) {
        if (error instanceof ProjectPersistenceError) throw error;
        if (!isMissingFile(error)) throw error;
      }
      return this.saveUnlocked(project);
    });
  }

  public async load(): Promise<FramekitProjectDocument> {
    let raw: string;
    try {
      raw = await this.fs.readFile(this.path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        throw new ProjectPersistenceError("PROJECT_NOT_FOUND", `project file does not exist: ${this.path}`, { path: this.path }, { cause: error });
      }
      throw new ProjectPersistenceError("PROJECT_CORRUPT", `project file could not be read: ${this.path}`, { path: this.path }, { cause: error });
    }

    try {
      return decodeFramekitProject(raw);
    } catch (error) {
      if (error instanceof ProjectPersistenceError) throw error;
      throw new ProjectPersistenceError("PROJECT_CORRUPT", `project file is invalid: ${this.path}`, { path: this.path }, { cause: error });
    }
  }

  public async save(
    project: FramekitProjectDocument,
    expectedRevision?: ContextRevision,
  ): Promise<FramekitProjectDocument> {
    return this.withProjectLock(() => this.saveUnlocked(project, expectedRevision));
  }

  private async saveUnlocked(
    project: FramekitProjectDocument,
    expectedRevision?: ContextRevision,
  ): Promise<FramekitProjectDocument> {
    try {
      validateFramekitProject(project);
    } catch (error) {
      throw new ProjectPersistenceError("PROJECT_INVALID", "project does not satisfy the canonical schema", undefined, { cause: error });
    }

    if (expectedRevision) {
      const current = await this.load();
      if (!sameRevision(current.timeline.revision, expectedRevision)) {
        throw new ProjectPersistenceError(
          "PROJECT_STALE_REVISION",
          "expected project revision does not match the persisted project",
          { expectedRevision, actualRevision: current.timeline.revision },
        );
      }
    }

    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await this.fs.mkdir(dirname(this.path), { recursive: true });
      await this.fs.writeFile(temporary, `${encodeFramekitProject(project)}\n`, { encoding: "utf8", flag: "wx" });
      await this.fs.rename(temporary, this.path);
      return structuredClone(project);
    } catch (error) {
      throw new ProjectPersistenceError("PROJECT_SAVE_FAILED", `atomic project write failed: ${this.path}`, { path: this.path }, { cause: error });
    } finally {
      await this.removeTemporaryFile(temporary);
    }
  }

  private async withProjectLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.fs.mkdir(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    const deadline = Date.now() + 2_000;

    while (true) {
      try {
        await this.fs.writeFile(lockPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
        break;
      } catch (error) {
        if (!isAlreadyExists(error)) {
          throw new ProjectPersistenceError("PROJECT_SAVE_FAILED", `could not acquire project lock: ${this.path}`, { path: this.path }, { cause: error });
        }
        if (await this.removeStaleLock(lockPath)) continue;
        if (Date.now() >= deadline) {
          throw new ProjectPersistenceError("PROJECT_SAVE_FAILED", `could not acquire project lock: ${this.path}`, { path: this.path }, { cause: error });
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    try {
      return await operation();
    } finally {
      await this.removeTemporaryFile(lockPath);
    }
  }

  private async removeStaleLock(lockPath: string): Promise<boolean> {
    let owner: string;
    try {
      owner = await this.fs.readFile(lockPath, "utf8");
    } catch (error) {
      return isMissingFile(error);
    }

    const pid = Number.parseInt(owner.trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0 || isProcessDead(pid)) {
      try {
        await this.fs.unlink(lockPath);
        return true;
      } catch (error) {
        return isMissingFile(error);
      }
    }
    return false;
  }

  private async removeTemporaryFile(path: string): Promise<void> {
    try {
      await this.fs.unlink(path);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
}

export function encodeFramekitProject(project: FramekitProjectDocument): string {
  validateFramekitProject(project);
  return stableJson(project);
}

export function decodeFramekitProject(input: string | unknown): FramekitProjectDocument {
  let value: unknown;
  try {
    value = typeof input === "string" ? JSON.parse(input) : input;
  } catch (error) {
    throw new ProjectPersistenceError("PROJECT_CORRUPT", "project JSON is malformed", undefined, { cause: error });
  }

  const record = asRecord(value);
  if (!record) throw new ProjectPersistenceError("PROJECT_CORRUPT", "project document must be an object");
  if (record.schemaVersion !== FRAMEKIT_PROJECT_SCHEMA_VERSION) {
    const code = typeof record.schemaVersion === "number" && record.schemaVersion > FRAMEKIT_PROJECT_SCHEMA_VERSION
      ? "PROJECT_SCHEMA_UNSUPPORTED"
      : "PROJECT_CORRUPT";
    throw new ProjectPersistenceError(code, `unsupported project schema version: ${String(record.schemaVersion)}`, {
      receivedSchemaVersion: record.schemaVersion,
      supportedSchemaVersion: FRAMEKIT_PROJECT_SCHEMA_VERSION,
    });
  }

  try {
    validateFramekitProject(record as unknown as FramekitProjectDocument);
  } catch (error) {
    throw new ProjectPersistenceError("PROJECT_CORRUPT", "project document does not satisfy the canonical schema", undefined, { cause: error });
  }
  return structuredClone(record as unknown as FramekitProjectDocument);
}

export function validateFramekitProject(project: FramekitProjectDocument): void {
  if (!project || typeof project !== "object" || project.schemaVersion !== FRAMEKIT_PROJECT_SCHEMA_VERSION) {
    throw new Error("PROJECT_INVALID: schemaVersion must be 1");
  }
  if (!project.metadata || typeof project.metadata !== "object") throw new Error("PROJECT_INVALID: metadata is required");
  requireText(project.metadata.createdAt, "metadata.createdAt");
  requireText(project.metadata.updatedAt, "metadata.updatedAt");
  validateTimelineIr(project.timeline);
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`PROJECT_INVALID: ${field} must be non-empty`);
}

function sameRevision(left: ContextRevision, right: ContextRevision): boolean {
  return left.id === right.id && left.sequence === right.sequence;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isProcessDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "EPERM";
  }
}
