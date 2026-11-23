import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { verifySpeechTranscriptArtifact, type SpeechTranscriptArtifact } from "../speech/transcript-artifact.js";

const maxBytes = 16 * 1024 * 1024;

/** Immutable content-addressed transcript records. Source freshness is checked separately by callers. */
export class SpeechTranscriptArtifactStore {
  public constructor(private readonly directory: string) {}

  public async save(artifact: SpeechTranscriptArtifact): Promise<void> {
    verifySpeechTranscriptArtifact(artifact, artifact.digest);
    const bytes = Buffer.from(`${JSON.stringify(artifact)}\n`);
    if (bytes.length > maxBytes) throw new Error("ANALYSIS_ARTIFACT_TOO_LARGE: transcript exceeds storage limit");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.assertDirectory();
    const target = this.path(artifact.digest);
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      try { await link(temporary, target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      await this.load(artifact.digest);
    } finally {
      try { await unlink(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }

  public async load(digest: string): Promise<SpeechTranscriptArtifact> {
    const path = this.path(digest);
    try {
      await this.assertDirectory();
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || before.size > BigInt(maxBytes)) throw new Error("invalid");
        const buffer = Buffer.alloc(Number(before.size) + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        const after = await handle.stat({ bigint: true });
        const named = await lstat(path, { bigint: true });
        if (BigInt(offset) !== before.size || !named.isFile() || named.isSymbolicLink()
          || [after, named].some((stat) => stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size
            || stat.mtimeNs !== before.mtimeNs)) throw new Error("invalid");
        return verifySpeechTranscriptArtifact(JSON.parse(buffer.subarray(0, offset).toString("utf8")), digest);
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("ANALYSIS_ARTIFACT_NOT_FOUND: transcript artifact is unavailable");
      throw new Error("ANALYSIS_ARTIFACT_CORRUPT: transcript artifact cannot be verified");
    }
  }

  private path(digest: string): string {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("ANALYSIS_ARTIFACT_INVALID: expected a SHA-256 digest");
    return join(this.directory, `${digest}.json`);
  }

  private async assertDirectory(): Promise<void> {
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("ANALYSIS_ARTIFACT_CORRUPT: unsafe storage directory");
  }
}
