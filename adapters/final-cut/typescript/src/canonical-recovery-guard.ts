import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { CanonicalRecoveryCheckpoint, CanonicalRecoveryGuard } from "./canonical.js";
import { inspectNativeRecoveryReadOnly, validRecoveryContext, type NativeMaterializationRecoveryContext, type NativePublishRecoveryContext } from "./native-recovery-inspection.js";

/** A durable, exclusive checkpoint; unresolved checkpoints are never cleared automatically. */
export class FileCanonicalRecoveryGuard implements CanonicalRecoveryGuard {
  private owner?: string;

  public constructor(private readonly path: string) {}

  public async assertClear(): Promise<void> {
    try {
      await lstat(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("FINAL_CUT_CANONICAL_RECOVERY_REQUIRED: cannot inspect recovery checkpoint", { cause: error });
    }
    throw new Error("FINAL_CUT_CANONICAL_RECOVERY_REQUIRED: unresolved canonical edit checkpoint exists");
  }

  /** Read native reservation and sender evidence without acquiring or modifying locks. */
  public async inspectNativeRecoveryEvidence() {
    return inspectNativeRecoveryReadOnly(this.path);
  }

  /** Return evidence only; inspection never clears or claims recovery. */
  public async inspect(): Promise<CanonicalRecoveryCheckpoint | undefined> {
    return (await this.inspectVersioned())?.checkpoint;
  }

  /** Inspect a direct native reservation without fabricating a canonical target. */
  public async inspectNativeReservation(): Promise<{ reservationId: string; operation: string } | undefined> {
    let handle;
    try {
      handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > 16_384) throw new Error("invalid reservation file");
      const contents = await handle.readFile("utf8");
      const record = JSON.parse(contents) as Record<string, unknown>;
      if ((record.version !== 2 && record.version !== 3) || record.kind !== "native-operation"
        || typeof record.owner !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.owner)
        || typeof record.operation !== "string" || !/^[a-z][a-z0-9.-]{0,127}$/.test(record.operation)
        || (record.version === 3 && !validRecoveryContext(record.recoveryContext, record.operation))) {
        throw new Error("invalid native reservation");
      }
      return { reservationId: createHash("sha256").update(contents).digest("hex"), operation: record.operation };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("FINAL_CUT_CANONICAL_RECOVERY_REQUIRED: cannot inspect native reservation", { cause: error });
    } finally {
      await handle?.close();
    }
  }

  /** Atomically reserve the same path used by canonical checkpoints. */
  public async beginNative(operation: string, context?: NativeMaterializationRecoveryContext | NativePublishRecoveryContext): Promise<{ reservationId: string; release(): Promise<void> }> {
    if (!/^[a-z][a-z0-9.-]{0,127}$/.test(operation)) throw new Error("INVALID_OPERATION: invalid native reservation operation");
    if (context && !validRecoveryContext(context, operation)) throw new Error("INVALID_OPERATION: invalid native recovery context");
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const owner = randomUUID();
    const version = context ? 3 : 2;
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
    return { reservationId: createHash("sha256").update(contents).digest("hex"), release: async () => {
      if (released) throw new Error("FINAL_CUT_CANONICAL_RECOVERY_REQUIRED: native reservation was already released");
      await this.completeOwned(owner, version);
      released = true;
    } };
  }

  public async inspectVersioned(): Promise<{ checkpointId: string; checkpoint: CanonicalRecoveryCheckpoint } | undefined> {
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
  }

  public async complete(): Promise<void> {
    if (!this.owner) throw new Error("FINAL_CUT_CANONICAL_RECOVERY_REQUIRED: checkpoint ownership is unavailable");
    await this.completeOwned(this.owner, 1);
    this.owner = undefined;
  }

  private async completeOwned(owner: string, version: number): Promise<void> {
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("invalid checkpoint");
      const record = JSON.parse(await readFile(this.path, "utf8")) as { version?: unknown; owner?: unknown };
      if (record.version !== version || record.owner !== owner) throw new Error("checkpoint ownership changed");
      await unlink(this.path);
    } catch (error) {
      throw new Error("FINAL_CUT_CANONICAL_RECOVERY_REQUIRED: cannot safely complete recovery checkpoint", { cause: error });
    }
  }
}
