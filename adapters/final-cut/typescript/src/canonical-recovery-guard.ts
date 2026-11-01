import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { CanonicalRecoveryGuard } from "./canonical.js";

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

  public async begin(checkpoint: { projectId: string; sequenceId: string; baseRevision: string; beforeDigest: string; operation: string }): Promise<void> {
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
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("invalid checkpoint");
      const record = JSON.parse(await readFile(this.path, "utf8")) as { version?: unknown; owner?: unknown };
      if (record.version !== 1 || record.owner !== this.owner) throw new Error("checkpoint ownership changed");
      await unlink(this.path);
      this.owner = undefined;
    } catch (error) {
      throw new Error("FINAL_CUT_CANONICAL_RECOVERY_REQUIRED: cannot safely complete recovery checkpoint", { cause: error });
    }
  }
}
