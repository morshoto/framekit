import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { CanonicalRecoveryCheckpoint, CanonicalRecoveryGuard } from "./canonical.js";

/** Requested evidence only: none of these fields establishes dispatch or quiescence. */
export interface NativeMaterializationRecoveryContext {
  kind: "materialization";
  jobId: string;
  dispatchId: string;
  requestedTarget: { libraryUid: string; eventUid: string; projectUid: string; sequenceUid: string };
  artifactDigest: string;
  desiredDigest: string;
  executorIdentity: null;
  nativeQuiescence: "unproven";
}

/** Requested library only; it is not a verified native target. */
export interface NativePublishRecoveryContext {
  kind: "publish";
  jobId: string;
  dispatchId: string;
  requestedTarget: { libraryPath: string };
  artifactDigest: string;
  executorIdentity: null;
  nativeQuiescence: "unproven";
}

/** A planned receiver identity and target, not proof that dispatch or completion occurred. */
export type RecoverableNativeContext = (Omit<NativeMaterializationRecoveryContext, "executorIdentity"> | Omit<NativePublishRecoveryContext, "executorIdentity">) & {
  executorIdentity: string;
  dispatchState: "intent";
  canonicalTarget: Record<string, string>;
  expectedCanonicalDigest: string;
  expectedRestoreDigest?: string;
};

export type NativeRecoveryContext = NativeMaterializationRecoveryContext | NativePublishRecoveryContext | RecoverableNativeContext;

function validPublishContext(value: unknown, operation: string): value is NativePublishRecoveryContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value as Partial<NativePublishRecoveryContext>;
  const path = c.requestedTarget?.libraryPath;
  return c.kind === "publish"
    && typeof c.jobId === "string" && /^publish-job-[a-z0-9-]{1,80}$/.test(c.jobId)
    && operation === `native.publish.${createHash("sha256").update(c.jobId).digest("hex")}`
    && typeof c.dispatchId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(c.dispatchId)
    && typeof path === "string" && path.length <= 4096 && isAbsolute(path) && path.endsWith(".fcpbundle")
    && typeof c.artifactDigest === "string" && /^[a-f0-9]{64}$/.test(c.artifactDigest)
    && c.executorIdentity === null && c.nativeQuiescence === "unproven";
}

function validRecoveryContext(value: unknown, operation: string): value is NativeRecoveryContext {
  return validMaterializationContext(value, operation) || validPublishContext(value, operation);
}

function validRecoverableContext(value: unknown, operation: string): value is RecoverableNativeContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value as RecoverableNativeContext;
  if (typeof c.executorIdentity !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(c.executorIdentity)
    || c.dispatchState !== "intent" || !/^[a-f0-9]{64}$/.test(c.expectedCanonicalDigest)
    || (c.expectedRestoreDigest !== undefined && !/^[a-f0-9]{64}$/.test(c.expectedRestoreDigest))
    || !validRecoveryContext({ ...c, executorIdentity: null }, operation)) return false;
  const t = c.canonicalTarget;
  if (!t || typeof t !== "object" || Array.isArray(t)) return false;
  const keys = c.kind === "publish" ? ["libraryPath", "projectUid", "sequenceUid"] : ["libraryUid", "eventUid", "projectUid", "sequenceUid"];
  if (Object.keys(t).length !== keys.length || !keys.every((key) => typeof t[key] === "string" && t[key].trim().length > 0 && t[key].length <= 1024)) return false;
  if (c.kind === "publish") return t.libraryPath === c.requestedTarget.libraryPath;
  return keys.every((key) => t[key] === (c.requestedTarget as Record<string, string>)[key])
    && c.expectedCanonicalDigest === c.desiredDigest;
}

function validMaterializationContext(value: unknown, operation: string): value is NativeMaterializationRecoveryContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value as Partial<NativeMaterializationRecoveryContext>;
  const t = c.requestedTarget;
  return c.kind === "materialization"
    && typeof c.jobId === "string" && /^materialization-[a-z0-9-]{1,80}$/.test(c.jobId)
    && operation === `native.materialize.${createHash("sha256").update(c.jobId).digest("hex")}`
    && typeof c.dispatchId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(c.dispatchId)
    && Boolean(t && [t.libraryUid, t.eventUid, t.projectUid, t.sequenceUid].every((x) => typeof x === "string" && x.trim().length > 0 && x.length <= 1024))
    && typeof c.artifactDigest === "string" && /^[a-f0-9]{64}$/.test(c.artifactDigest)
    && typeof c.desiredDigest === "string" && /^[a-f0-9]{64}$/.test(c.desiredDigest)
    && c.executorIdentity === null && c.nativeQuiescence === "unproven";
}

/** A durable, exclusive checkpoint; unresolved checkpoints are never cleared automatically. */
export class FileCanonicalRecoveryGuard implements CanonicalRecoveryGuard {
  private owner?: string;

  public constructor(private readonly path: string) {}

  public async assertClear(): Promise<void> {
    await this.assertNoTransaction();
    try {
      await lstat(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.assertNoTransaction();
        return;
      }
      throw new Error("FINAL_CUT_CANONICAL_RECOVERY_REQUIRED: cannot inspect recovery checkpoint", { cause: error });
    }
    throw new Error("FINAL_CUT_CANONICAL_RECOVERY_REQUIRED: unresolved canonical edit checkpoint exists");
  }

  /** Return evidence only; inspection never clears or claims recovery. */
  public async inspect(): Promise<CanonicalRecoveryCheckpoint | undefined> {
    return (await this.inspectVersioned())?.checkpoint;
  }

  /** Inspect a direct native reservation without fabricating a canonical target. */
  public async inspectNativeReservation(): Promise<{ reservationId: string; operation: string; recoveryContext?: NativeRecoveryContext } | undefined> {
    return this.withInspectionTransaction(() => this.readNativeReservation());
  }

  private async readNativeReservation(): Promise<{ reservationId: string; operation: string; recoveryContext?: NativeRecoveryContext } | undefined> {
    let handle;
    try {
      handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > 16_384) throw new Error("invalid reservation file");
      const contents = await handle.readFile("utf8");
      const record = JSON.parse(contents) as Record<string, unknown>;
      if ((record.version !== 2 && record.version !== 3 && record.version !== 4) || record.kind !== "native-operation"
        || typeof record.owner !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.owner)
        || typeof record.operation !== "string" || !/^[a-z][a-z0-9.-]{0,127}$/.test(record.operation)) {
        throw new Error("invalid native reservation");
      }
      if (record.version === 3 && !validRecoveryContext(record.recoveryContext, record.operation)) throw new Error("invalid recovery context");
      if (record.version === 4 && !validRecoverableContext(record.recoveryContext, record.operation)) throw new Error("invalid recoverable context");
      return { reservationId: createHash("sha256").update(contents).digest("hex"), operation: record.operation,
        ...(record.version === 3 || record.version === 4 ? { recoveryContext: record.recoveryContext as NativeRecoveryContext } : {}) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("FINAL_CUT_CANONICAL_RECOVERY_REQUIRED: cannot inspect native reservation", { cause: error });
    } finally {
      await handle?.close();
    }
  }

  /** Atomically reserve the same path used by canonical checkpoints. */
  public async beginNative(operation: string, recoveryContext?: NativeRecoveryContext): Promise<{ reservationId: string; release(): Promise<void> }> {
    if (!/^[a-z][a-z0-9.-]{0,127}$/.test(operation)) throw new Error("INVALID_OPERATION: invalid native reservation operation");
    const context = recoveryContext && structuredClone(recoveryContext);
    if (context && !(context.executorIdentity === null ? validRecoveryContext(context, operation) : validRecoverableContext(context, operation))) throw new Error("INVALID_OPERATION: invalid native recovery context");
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    return this.withTransaction(async () => {
      const owner = randomUUID();
      const version = context ? (context.executorIdentity === null ? 3 : 4) : 2;
      const contents = JSON.stringify({ version, kind: "native-operation", owner, operation, ...(context ? { recoveryContext: context } : {}) }) + "\n";
      let handle;
      try {
        handle = await open(this.path, "wx", 0o600);
        await handle.writeFile(contents, "utf8");
        await handle.sync();
      } catch (error) {
        throw new Error("FINAL_CUT_CANONICAL_RECOVERY_REQUIRED: cannot create exclusive native reservation", { cause: error });
      } finally {
        await handle?.close();
      }
      let released = false;
      let releaseInFlight: Promise<void> | undefined;
      return { reservationId: createHash("sha256").update(contents).digest("hex"), release: async () => {
        if (released) return;
        if (!releaseInFlight) {
          releaseInFlight = this.completeOwned(owner, version).then(() => { released = true; });
        }
        const pending = releaseInFlight;
        try {
          await pending;
        } finally {
          if (releaseInFlight === pending) releaseInFlight = undefined;
        }
      } };
    });
  }

  public async inspectVersioned(): Promise<{ checkpointId: string; checkpoint: CanonicalRecoveryCheckpoint } | undefined> {
    return this.withInspectionTransaction(() => this.readVersioned());
  }

  private async readVersioned(): Promise<{ checkpointId: string; checkpoint: CanonicalRecoveryCheckpoint } | undefined> {
    let handle;
    try {
      handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > 16_384) throw new Error("invalid checkpoint file");
      const contents = await handle.readFile("utf8");
      const record = JSON.parse(contents) as Record<string, unknown>;
      if (record.version !== 1 || typeof record.owner !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.owner)
        || !record.checkpoint || typeof record.checkpoint !== "object" || Array.isArray(record.checkpoint)) {
        throw new Error("invalid checkpoint record");
      }
      const checkpoint = record.checkpoint as Record<string, unknown>;
      const { projectId, sequenceId, baseRevision, beforeDigest, operation, expectedRestoreDigest } = checkpoint;
      if (typeof projectId !== "string" || !projectId.trim()
        || typeof sequenceId !== "string" || !sequenceId.trim()
        || typeof baseRevision !== "string" || !baseRevision.trim()
        || typeof beforeDigest !== "string" || !/^[a-f0-9]{64}$/i.test(beforeDigest)
        || typeof operation !== "string" || !["rename-clip", "trim-clip", "add-marker", "ripple-delete", "set-gain", "undo"].includes(operation)
        || (expectedRestoreDigest !== undefined && (typeof expectedRestoreDigest !== "string" || !/^[a-f0-9]{64}$/i.test(expectedRestoreDigest)))) {
        throw new Error("incomplete checkpoint evidence");
      }
      return {
        checkpointId: createHash("sha256").update(contents).digest("hex"),
        checkpoint: { projectId, sequenceId, baseRevision, beforeDigest, operation,
          ...(typeof expectedRestoreDigest === "string" ? { expectedRestoreDigest } : {}) },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("FINAL_CUT_CANONICAL_RECOVERY_REQUIRED: cannot inspect recovery evidence", { cause: error });
    } finally {
      await handle?.close();
    }
  }

  public async begin(checkpoint: CanonicalRecoveryCheckpoint): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await this.withTransaction(async () => {
      let handle;
      try {
        handle = await open(this.path, "wx", 0o600);
        const owner = randomUUID();
        await handle.writeFile(JSON.stringify({ version: 1, owner, checkpoint }) + "\n", "utf8");
        await handle.sync();
        this.owner = owner;
      } catch (error) {
        throw new Error("FINAL_CUT_CANONICAL_RECOVERY_REQUIRED: cannot create exclusive recovery checkpoint", { cause: error });
      } finally {
        await handle?.close();
      }
    });
  }

  public async complete(): Promise<void> {
    if (!this.owner) throw new Error("FINAL_CUT_CANONICAL_RECOVERY_REQUIRED: checkpoint ownership is unavailable");
    await this.completeOwned(this.owner, 1);
    this.owner = undefined;
  }

  /** Internal recovery seam. The verifier must be backed by an authoritative receiver. */
  public async completeVerifiedNative(
    reservationId: string,
    outcome: "completed" | "restored",
    verify: (reservation: NonNullable<Awaited<ReturnType<FileCanonicalRecoveryGuard["inspectNativeReservation"]>>>) => Promise<{ receiptId: string; outcome: "completed" | "restored" }>,
  ): Promise<{ outcome: "completed" | "restored"; alreadyReleased: boolean }> {
    if (!/^[a-f0-9]{64}$/.test(reservationId) || !["completed", "restored"].includes(outcome)) throw new Error("RECOVERY_EVIDENCE_INVALID: invalid recovery identity");
    return this.withTransaction(async () => {
      const receiptDirectory = `${this.path}.completed`;
      const receiptPath = join(receiptDirectory, reservationId);
      const proofPath = `${receiptPath}.proof`;
      let currentId: string | undefined;
      try {
        currentId = createHash("sha256").update(await this.readRecoveryFile(this.path)).digest("hex");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (currentId !== reservationId) {
        try {
          const record = await this.readRecoveryFile(receiptPath);
          const proof = JSON.parse((await this.readRecoveryFile(proofPath)).toString("utf8")) as { reservationId?: unknown; outcome?: unknown; receiptId?: unknown };
          if (createHash("sha256").update(record).digest("hex") !== reservationId || proof.reservationId !== reservationId
            || proof.outcome !== outcome || typeof proof.receiptId !== "string" || !proof.receiptId.trim()) throw new Error("invalid completed recovery record");
          return { outcome, alreadyReleased: true };
        } catch (error) {
          throw new Error("RECOVERY_EVIDENCE_INVALID: no matching completed recovery", { cause: error });
        }
      }
      const current = await this.readNativeReservation();
      if (!current || current.reservationId !== reservationId) throw new Error("RECOVERY_EVIDENCE_INVALID: reservation changed before verification");
      if (!current.recoveryContext || typeof current.recoveryContext.executorIdentity !== "string" || !("canonicalTarget" in current.recoveryContext)) {
        throw new Error("RECOVERY_EVIDENCE_INVALID: reservation lacks a bound receiver");
      }
      const verified = await verify(current);
      if (!verified || verified.outcome !== outcome || typeof verified.receiptId !== "string" || !verified.receiptId.trim() || verified.receiptId.length > 1024) {
        throw new Error("RECOVERY_EVIDENCE_INVALID: verification did not prove the requested outcome");
      }
      if ((await this.readNativeReservation())?.reservationId !== reservationId) throw new Error("RECOVERY_EVIDENCE_INVALID: reservation changed during verification");
      try {
        await mkdir(receiptDirectory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const info = await lstat(receiptDirectory);
        if (!info.isDirectory() || info.isSymbolicLink()) {
          throw new Error("RECOVERY_EVIDENCE_INVALID: invalid completed recovery directory", { cause: error });
        }
      }
      const proof = JSON.stringify({ reservationId, outcome, receiptId: verified.receiptId }) + "\n";
      try {
        const proofHandle = await open(proofPath, "wx", 0o600);
        try { await proofHandle.writeFile(proof); await proofHandle.sync(); } finally { await proofHandle.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || (await this.readRecoveryFile(proofPath)).toString("utf8") !== proof) throw error;
      }
      try {
        await link(this.path, receiptPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || createHash("sha256").update(await this.readRecoveryFile(receiptPath)).digest("hex") !== reservationId) throw error;
      }
      const directory = await open(receiptDirectory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
      await unlink(this.path);
      const parent = await open(dirname(this.path), "r");
      try { await parent.sync(); } finally { await parent.close(); }
      return { outcome, alreadyReleased: false };
    });
  }

  private async readRecoveryFile(path: string): Promise<Buffer> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 16_384) throw new Error("invalid recovery record");
      return await handle.readFile();
    } finally { await handle.close(); }
  }

  private async completeOwned(owner: string, version: number): Promise<void> {
    await this.withTransaction(async () => {
      try {
        const info = await lstat(this.path);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("invalid checkpoint");
        const record = JSON.parse(await readFile(this.path, "utf8")) as { version?: unknown; owner?: unknown };
        if (record.version !== version || record.owner !== owner) throw new Error("checkpoint ownership changed");
        await unlink(this.path);
      } catch (error) {
        throw new Error("FINAL_CUT_CANONICAL_RECOVERY_REQUIRED: cannot safely complete recovery checkpoint", { cause: error });
      }
    });
  }

  private async assertNoTransaction(): Promise<void> {
    try {
      await lstat(`${this.path}.lock`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("FINAL_CUT_CANONICAL_RECOVERY_REQUIRED: cannot inspect recovery transaction", { cause: error });
    }
    throw new Error("FINAL_CUT_CANONICAL_RECOVERY_REQUIRED: recovery transaction is unresolved");
  }

  private async withInspectionTransaction<T>(read: () => Promise<T | undefined>): Promise<T | undefined> {
    try {
      await lstat(dirname(this.path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("FINAL_CUT_CANONICAL_RECOVERY_REQUIRED: cannot inspect recovery directory", { cause: error });
    }
    return this.withTransaction(read);
  }

  /** A crashed transaction deliberately leaves the lock in place for manual investigation. */
  private async withTransaction<T>(operation: () => Promise<T>): Promise<T> {
    const lock = `${this.path}.lock`;
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      throw new Error("FINAL_CUT_CANONICAL_RECOVERY_REQUIRED: recovery transaction is unavailable", { cause: error });
    }
    try {
      return await operation();
    } finally {
      try {
        await rmdir(lock);
      } catch (error) {
        throw new Error("FINAL_CUT_CANONICAL_RECOVERY_REQUIRED: recovery transaction could not be closed", { cause: error });
      }
    }
  }
}
