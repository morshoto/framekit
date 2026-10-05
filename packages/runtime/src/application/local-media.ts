import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ContextRevision } from "../domain/primitives.js";
import {
  FramekitProjectStore,
  type FramekitProjectDocument,
} from "./project-store.js";
import type {
  TimelineIrMediaMetadata,
  TimelineIrResource,
} from "../timeline/editing-session.js";

export interface LocalMediaMetadataProbe {
  probe(sourcePath: string): Promise<TimelineIrMediaMetadata>;
}

export type LocalMediaRegistrationStatus = "registered" | "already-registered";

export interface LocalMediaRegistrationResult {
  status: LocalMediaRegistrationStatus;
  project: FramekitProjectDocument;
  resource: TimelineIrResource;
}

export type RegisteredMediaStatus =
  | { id: string; source: string; status: "available"; expectedDigest: string; actualDigest: string }
  | { id: string; source: string; status: "missing"; expectedDigest: string }
  | { id: string; source: string; status: "changed"; expectedDigest: string; actualDigest: string };

export class LocalMediaError extends Error {
  public readonly code: "MEDIA_MISSING" | "MEDIA_CHANGED" | "MEDIA_AMBIGUOUS";
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(
    code: LocalMediaError["code"],
    message: string,
    details: Readonly<Record<string, unknown>>,
  ) {
    super(`${code}: ${message}`);
    this.name = "LocalMediaError";
    this.code = code;
    this.details = details;
  }
}

export class LocalMediaRegistrar {
  private readonly clock: () => string;

  public constructor(
    private readonly store: FramekitProjectStore,
    private readonly metadataProbe: LocalMediaMetadataProbe,
    options: { clock?: () => string } = {},
  ) {
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  public async register(sourcePath: string, expectedRevision?: ContextRevision): Promise<LocalMediaRegistrationResult> {
    const source = await inspectLocalFile(sourcePath);
    const digest = await digestFile(source.path);
    await assertStableSource(source, digest);
    const project = await this.store.load();
    if (expectedRevision && !sameRevision(project.timeline.revision, expectedRevision)) {
      throw new LocalMediaError("MEDIA_CHANGED", "project revision changed before media registration", {
        expectedRevision,
        actualRevision: project.timeline.revision,
      });
    }

    const existing = project.timeline.resources.find((resource) => resource.source === source.path);
    if (existing) {
      if (existing.sourceDigest !== digest) {
        throw new LocalMediaError("MEDIA_CHANGED", `registered source changed: ${source.path}`, {
          id: existing.id,
          source: source.path,
          expectedDigest: existing.sourceDigest,
          actualDigest: digest,
        });
      }
      await assertStableSource(source, digest);
      return { status: "already-registered", project, resource: structuredClone(existing) };
    }

    const metadata = await this.metadataProbe.probe(source.path);
    await assertStableSource(source, digest);
    const resource: TimelineIrResource = {
      id: stableMediaId(source.path, digest),
      name: basename(source.path),
      mediaKind: metadata.streams.some((stream) => stream.kind === "video") ? "video" : "audio",
      source: source.path,
      sourceKind: "local-file",
      sourceDigest: digest,
      metadata: structuredClone(metadata),
    };
    const next = structuredClone(project);
    next.timeline.resources.push(resource);
    const timestamp = this.clock();
    next.timeline.revision = nextRevision(project.timeline.revision, timestamp);
    next.metadata.updatedAt = timestamp;
    const saved = await this.store.save(next, project.timeline.revision);
    return { status: "registered", project: saved, resource: structuredClone(resource) };
  }

  public async inspect(project?: FramekitProjectDocument): Promise<RegisteredMediaStatus[]> {
    const loadedProject = project ?? await this.store.load();
    const results: RegisteredMediaStatus[] = [];
    for (const resource of loadedProject.timeline.resources) {
      if (resource.sourceKind !== "local-file" || !resource.source || !resource.sourceDigest) continue;
      try {
        const source = await inspectLocalFile(resource.source);
        const actualDigest = await digestFile(source.path);
        await assertStableSource(source, actualDigest);
        results.push(actualDigest === resource.sourceDigest
          ? { id: resource.id, source: source.path, status: "available", expectedDigest: resource.sourceDigest, actualDigest }
          : { id: resource.id, source: source.path, status: "changed", expectedDigest: resource.sourceDigest, actualDigest });
      } catch (error) {
        if (error instanceof LocalMediaError && error.code === "MEDIA_MISSING") {
          results.push({ id: resource.id, source: resource.source, status: "missing", expectedDigest: resource.sourceDigest });
          continue;
        }
        throw error;
      }
    }
    return results;
  }

  public async reopen(): Promise<FramekitProjectDocument> {
    const project = await this.store.load();
    const statuses = await this.inspect(project);
    const invalid = statuses.find((status) => status.status !== "available");
    if (invalid?.status === "missing") {
      throw new LocalMediaError("MEDIA_MISSING", `registered source is missing: ${invalid.source}`, { media: statuses });
    }
    if (invalid?.status === "changed") {
      throw new LocalMediaError("MEDIA_CHANGED", `registered source changed: ${invalid.source}`, { media: statuses });
    }
    return project;
  }
}

interface LocalFileIdentity {
  path: string;
  device: number;
  inode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

async function inspectLocalFile(sourcePath: string): Promise<LocalFileIdentity> {
  const path = resolve(sourcePath);
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new LocalMediaError("MEDIA_MISSING", `local source does not exist: ${path}`, { source: path });
    }
    throw error;
  }
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new LocalMediaError("MEDIA_AMBIGUOUS", `local source is not a regular file: ${path}`, { source: path });
  }
  return { path, device: details.dev, inode: details.ino, size: details.size, mtimeMs: details.mtimeMs, ctimeMs: details.ctimeMs };
}

async function assertStableSource(identity: LocalFileIdentity, expectedDigest: string): Promise<void> {
  const current = await inspectLocalFile(identity.path);
  if (current.device !== identity.device
    || current.inode !== identity.inode
    || current.size !== identity.size
    || current.mtimeMs !== identity.mtimeMs
    || current.ctimeMs !== identity.ctimeMs
    || await digestFile(current.path) !== expectedDigest) {
    throw new LocalMediaError("MEDIA_CHANGED", `local source changed during registration: ${identity.path}`, {
      source: identity.path,
      expectedDigest,
    });
  }
}

async function digestFile(path: string): Promise<string> {
  const digest = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: string | Buffer) => digest.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolvePromise);
  });
  return digest.digest("hex");
}

function stableMediaId(path: string, digest: string): string {
  return `local-media:${createHash("sha256").update(`${path}\0${digest}`).digest("hex")}`;
}

function sameRevision(left: ContextRevision, right: ContextRevision): boolean {
  return left.id === right.id && left.sequence === right.sequence;
}

function nextRevision(previous: ContextRevision, timestamp: string): ContextRevision {
  return {
    id: `revision-${createHash("sha256").update(`${previous.id}\0${previous.sequence + 1}\0${timestamp}`).digest("hex")}`,
    sequence: previous.sequence + 1,
    timestamp,
  };
}
