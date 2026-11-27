import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { acceptCreativeBrief, assertBriefBinding, creativeBriefDigest, reviseCreativeBrief } from "../planning/creative-brief.js";
import type { AcceptedCreativeBrief, CreativeBrief } from "../planning/creative-brief.js";
import type { ContextRevision } from "../domain/primitives.js";
import type { ProjectStore } from "./project-store.js";

export interface CreativeBriefProjectBinding {
  sequenceId: string;
  revision: ContextRevision;
  timelineDigest: string;
}

export type StoredCreativeBrief = {
  schemaVersion: 1;
  projectId: string;
  brief: CreativeBrief;
  digest: string;
} & ({ state: "draft" } | { state: "accepted"; accepted: AcceptedCreativeBrief; projectBinding?: CreativeBriefProjectBinding });

/** Each store path is owned by one project; callers must resolve it from trusted project identity. */
export interface CreativeBriefStore {
  create(projectId: string, brief: CreativeBrief): Promise<StoredCreativeBrief>;
  read(projectId: string): Promise<StoredCreativeBrief>;
  revise(projectId: string, expectedDigest: string, proposed: CreativeBrief): Promise<StoredCreativeBrief>;
  accept(projectId: string, expectedDigest: string, guard?: (publish: () => Promise<StoredCreativeBrief>) => Promise<StoredCreativeBrief>, projectBinding?: CreativeBriefProjectBinding): Promise<StoredCreativeBrief>;
  withAcceptedBrief<T>(projectId: string, accepted: AcceptedCreativeBrief, operation: (lockedProject: ProjectStore) => Promise<T>): Promise<T>;
}

export type CreativeBriefProjectGuard = <T>(binding: CreativeBriefProjectBinding, operation: (lockedProject: ProjectStore) => Promise<T>) => Promise<T>;

function validProjectId(projectId: unknown): projectId is string {
  return typeof projectId === "string" && projectId.trim().length > 0;
}
function isCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === code;
}

/** Atomic local storage with compare-and-swap; uncertain locks are never reclaimed automatically. */
export class JsonCreativeBriefStore implements CreativeBriefStore {
  constructor(private readonly path: string, private readonly withVerifiedProject?: CreativeBriefProjectGuard) {}

  async create(projectId: string, brief: CreativeBrief): Promise<StoredCreativeBrief> {
    const bound = structuredClone(brief);
    if (!validProjectId(projectId) || bound.version !== 1) throw new Error("INVALID_BRIEF: project identity and initial version are required");
    const document: StoredCreativeBrief = { schemaVersion: 1, projectId, brief: bound, digest: creativeBriefDigest(bound), state: "draft" };
    return this.locked(async () => {
      try { await lstat(this.path); throw new Error("BRIEF_ALREADY_EXISTS: project already has a brief"); }
      catch (error) { if (!isCode(error, "ENOENT")) throw error; }
      await this.publish(document, true);
      return structuredClone(document);
    });
  }

  async read(projectId: string): Promise<StoredCreativeBrief> {
    await this.assertNoPendingAcceptance();
    const result = await this.readUnlocked(projectId);
    await this.assertNoPendingAcceptance();
    return result;
  }

  private async assertNoPendingAcceptance(): Promise<void> {
    try { await lstat(`${this.path}.accepting`); }
    catch (error) { if (isCode(error, "ENOENT")) return; throw error; }
    throw new Error("BRIEF_RECONCILIATION_REQUIRED: acceptance publication was interrupted or is in progress");
  }

  private async readUnlocked(projectId: string): Promise<StoredCreativeBrief> {
    if (!validProjectId(projectId)) throw new Error("TARGET_MISMATCH: project identity is required");
    let raw: string;
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1_048_576) throw new Error("unsafe file");
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (isCode(error, "ENOENT")) throw new Error("BRIEF_NOT_FOUND: no brief exists for this project");
      throw new Error("BRIEF_CORRUPT: stored brief cannot be read", { cause: error });
    }
    let document: StoredCreativeBrief;
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid document");
      document = value as StoredCreativeBrief;
      const keys = Object.keys(document).sort().join(",");
      if (document.schemaVersion !== 1 || !validProjectId(document.projectId)
        || (document.state === "draft" ? keys !== "brief,digest,projectId,schemaVersion,state"
          : document.state === "accepted" ? keys !== "accepted,brief,digest,projectId,schemaVersion,state" && keys !== "accepted,brief,digest,projectBinding,projectId,schemaVersion,state" : true)
        || !/^[a-f0-9]{64}$/.test(document.digest) || creativeBriefDigest(document.brief) !== document.digest) throw new Error("invalid document");
      if (document.state === "accepted") assertBriefBinding(document.accepted, document.brief);
      if (document.state === "accepted" && "projectBinding" in document) validateProjectBinding(document.projectBinding!);
    } catch (error) {
      throw new Error("BRIEF_CORRUPT: stored brief or approval is invalid", { cause: error });
    }
    if (document.projectId !== projectId) throw new Error("TARGET_MISMATCH: stored brief belongs to a different project");
    return structuredClone(document);
  }

  async revise(projectId: string, expectedDigest: string, proposed: CreativeBrief): Promise<StoredCreativeBrief> {
    const bound = structuredClone(proposed);
    return this.locked(async () => {
      const current = await this.read(projectId);
      if (current.digest !== expectedDigest) throw new Error("STALE_BRIEF: the reviewed draft changed");
      const brief = reviseCreativeBrief(current.brief, bound);
      const next: StoredCreativeBrief = { schemaVersion: 1, projectId, brief, digest: creativeBriefDigest(brief), state: "draft" };
      await this.publish(next, false);
      return structuredClone(next);
    });
  }

  async accept(projectId: string, expectedDigest: string, guard?: (publish: () => Promise<StoredCreativeBrief>) => Promise<StoredCreativeBrief>, projectBinding?: CreativeBriefProjectBinding): Promise<StoredCreativeBrief> {
    const binding = projectBinding === undefined ? undefined : structuredClone(projectBinding);
    if (binding) validateProjectBinding(binding);
    if (binding && !guard) throw new Error("BRIEF_TARGET_UNVERIFIED: guarded publication is required");
    return this.locked(async () => {
      const current = await this.read(projectId);
      if (current.digest !== expectedDigest) throw new Error("STALE_BRIEF: the reviewed draft changed");
      const accepted = acceptCreativeBrief(current.brief);
      const next: StoredCreativeBrief = { schemaVersion: 1, projectId, brief: current.brief, digest: current.digest, state: "accepted", accepted, ...(binding ? { projectBinding: binding } : {}) };
      if (!guard) {
        await this.publish(next, false);
        return structuredClone(next);
      }
      const marker = `${this.path}.accepting`;
      await writeFile(marker, `${process.pid}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      let published = false;
      let publicationStarted = false;
      let called = false;
      try {
        const result = await guard(async () => {
          if (called) throw new Error("BRIEF_RECONCILIATION_REQUIRED: duplicate publication");
          called = true;
          publicationStarted = true;
          await this.publish(next, false);
          published = true;
          await unlink(marker);
          return structuredClone(next);
        });
        if (!published) throw new Error("BRIEF_RECONCILIATION_REQUIRED: acceptance was not published");
        return result;
      } catch (error) {
        // A failed publication may have reached disk; retain the marker if uncertain.
        if (!publicationStarted) await unlink(marker);
        throw error;
      }
    });
  }

  /** Serialize a bound operation with cooperating brief writers; this is not a source or editor lock. */
  async withAcceptedBrief<T>(projectId: string, accepted: AcceptedCreativeBrief, operation: (lockedProject: ProjectStore) => Promise<T>): Promise<T> {
    const bound = structuredClone(accepted);
    return this.locked(async () => {
      await assertCurrentAcceptedBrief(this, projectId, bound);
      const current = await this.read(projectId);
      if (current.state !== "accepted") throw new Error("BRIEF_NOT_ACCEPTED: the current brief requires review");
      if (!current.projectBinding || !this.withVerifiedProject) throw new Error("BRIEF_TARGET_UNVERIFIED: a project-bound acceptance and guard are required");
      return this.withVerifiedProject(structuredClone(current.projectBinding), operation);
    });
  }

  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    const lock = `${this.path}.lock`;
    try { await writeFile(lock, `${process.pid}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (isCode(error, "EEXIST")) throw new Error("BRIEF_BUSY: another or interrupted writer retains the lock");
      throw error;
    }
    try { return await operation(); }
    finally { await unlink(lock); }
  }

  private async publish(document: StoredCreativeBrief, createOnly: boolean): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(document)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      if (createOnly) await link(temporary, this.path);
      else await rename(temporary, this.path);
    } finally {
      try { await unlink(temporary); } catch (error) { if (!isCode(error, "ENOENT")) throw error; }
    }
  }
}

function validateProjectBinding(binding: CreativeBriefProjectBinding): void {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)
    || Object.keys(binding).sort().join(",") !== "revision,sequenceId,timelineDigest"
    || typeof binding.sequenceId !== "string" || !binding.sequenceId.trim()
    || !binding.revision || typeof binding.revision !== "object" || Array.isArray(binding.revision)
    || Object.keys(binding.revision).sort().join(",") !== "id,sequence,timestamp"
    || typeof binding.revision.id !== "string" || !binding.revision.id.trim()
    || !Number.isSafeInteger(binding.revision.sequence) || binding.revision.sequence < 0
    || typeof binding.revision.timestamp !== "string" || !binding.revision.timestamp.trim()
    || typeof binding.timelineDigest !== "string" || !/^[a-f0-9]{64}$/.test(binding.timelineDigest)) {
    throw new Error("INVALID_BRIEF_TARGET: invalid project binding");
  }
}

/** Check the current stored state, not a caller-supplied historical draft. */
export async function assertCurrentAcceptedBrief(store: CreativeBriefStore, projectId: string, accepted: AcceptedCreativeBrief): Promise<void> {
  accepted = structuredClone(accepted);
  const current = await store.read(projectId);
  if (current.state !== "accepted") throw new Error("BRIEF_NOT_ACCEPTED: the current brief requires review");
  if (!accepted || accepted.id !== current.accepted.id || accepted.version !== current.accepted.version || accepted.digest !== current.accepted.digest) throw new Error("STALE_BRIEF: acceptance is not current");
  assertBriefBinding(accepted, current.brief);
}
