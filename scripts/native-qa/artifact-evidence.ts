import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { publishQaRecord } from "./atomic-record.js";
import { assertQaJobIndex, inspectRun } from "./run-store.js";

interface ArtifactRecord {
  schemaVersion: 1;
  tier: "artifact";
  result: "digest-matched";
  artifactDigest: string;
  checkedAt: string;
}
const maxArtifactBytes = 512n * 1024n * 1024n;

/** Historical digest evidence only; it never establishes current native state or consent. */
export async function readQaArtifactEvidence(root: string, qaRunId: string) {
  const run = await inspectRun(root, qaRunId);
  const path = join(root, qaRunId, "artifact-evidence.json");
  try {
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error("QA_RUN_UNSAFE_PATH");
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    const item = value as Record<string, unknown>;
    if (Object.keys(item).sort().join(",") !== "artifactDigest,checkedAt,result,schemaVersion,tier"
      || item.schemaVersion !== 1 || item.tier !== "artifact" || item.result !== "digest-matched"
      || item.artifactDigest !== run.manifest.artifactDigest || typeof item.checkedAt !== "string"
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(item.checkedAt)
      || !Number.isFinite(Date.parse(item.checkedAt)) || new Date(item.checkedAt).toISOString() !== item.checkedAt) throw new Error("invalid");
    return { ...item as unknown as ArtifactRecord, scope: "snapshot-only" as const, dispatchAllowed: false as const };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof Error && error.message === "QA_RUN_UNSAFE_PATH") throw error;
    throw new Error("QA_EVIDENCE_CORRUPT");
  }
}

/** Hash a stable regular-file snapshot. This is not a dispatch-time validation. */
export async function verifyQaArtifact(root: string, qaRunId: string, artifactPath: string) {
  const run = await inspectRun(root, qaRunId);
  await assertQaJobIndex(root, run.manifest);
  if (typeof artifactPath !== "string" || !isAbsolute(artifactPath)) throw new Error("QA_ARTIFACT_UNSAFE");
  let file;
  try { file = await open(artifactPath, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new Error("QA_ARTIFACT_UNSAFE"); }
  let actualDigest: string;
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > maxArtifactBytes) throw new Error("QA_ARTIFACT_UNSAFE");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytesRead: number;
    let total = 0n;
    do {
      ({ bytesRead } = await file.read(buffer, 0, buffer.length, null));
      total += BigInt(bytesRead);
      if (total > maxArtifactBytes) throw new Error("QA_ARTIFACT_CHANGED");
      hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
    if (total !== before.size) throw new Error("QA_ARTIFACT_CHANGED");
    const after = await file.stat({ bigint: true });
    let current;
    try { current = await lstat(artifactPath, { bigint: true }); }
    catch { throw new Error("QA_ARTIFACT_CHANGED"); }
    const unchanged = [after, current].every(item => item.isFile() && !item.isSymbolicLink()
      && item.dev === before.dev && item.ino === before.ino && item.size === before.size
      && item.mtimeNs === before.mtimeNs && item.ctimeNs === before.ctimeNs);
    if (!unchanged) throw new Error("QA_ARTIFACT_CHANGED");
    actualDigest = hash.digest("hex");
  } finally { await file.close(); }
  if (actualDigest !== run.manifest.artifactDigest) throw new Error("QA_ARTIFACT_DIGEST_MISMATCH");
  const record: ArtifactRecord = { schemaVersion: 1, tier: "artifact", result: "digest-matched", artifactDigest: actualDigest, checkedAt: new Date().toISOString() };
  try { await publishQaRecord(join(root, qaRunId, "artifact-evidence.json"), `${JSON.stringify(record)}\n`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const evidence = await readQaArtifactEvidence(root, qaRunId);
  if (!evidence) throw new Error("QA_EVIDENCE_CORRUPT");
  return evidence;
}
