import { readQaRecord } from "./read-record.js";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { FcpxmlDocumentAdapter } from "../../adapters/final-cut/typescript/src/fcpxml.js";
import { verifyAcceptanceFixture } from "../final-cut-publisher-verification.mjs";
import { publishQaRecord } from "./atomic-record.js";
import { assertQaJobIndex, inspectRun } from "./run-store.js";

const limit = 16n * 1024n * 1024n;
type FixtureRecord = { schemaVersion: 1; tier: "publisher-fixture"; profile: "publisher-e2e-v1"; result: "matched"; artifactDigest: string; checkedAt: string };

/** Read historical fixture evidence; it never establishes dispatch safety or current source identity. */
export async function readQaPublisherFixtureEvidence(root: string, qaRunId: string) {
  const run = await inspectRun(root, qaRunId);
  const path = join(root, qaRunId, "publisher-fixture-evidence.json");
  try {
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error("QA_RUN_UNSAFE_PATH");
    if (file.size > 4096) throw new Error("invalid");
    const value: unknown = JSON.parse(await readQaRecord(path));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    const item = value as Record<string, unknown>;
    if (Object.keys(item).sort().join(",") !== "artifactDigest,checkedAt,profile,result,schemaVersion,tier"
      || item.schemaVersion !== 1 || item.tier !== "publisher-fixture" || item.profile !== "publisher-e2e-v1" || item.result !== "matched"
      || item.artifactDigest !== run.manifest.artifactDigest || typeof item.checkedAt !== "string"
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(item.checkedAt)
      || !Number.isFinite(Date.parse(item.checkedAt)) || new Date(item.checkedAt).toISOString() !== item.checkedAt) throw new Error("invalid");
    return { ...item as unknown as FixtureRecord, scope: "snapshot-only" as const, dispatchAllowed: false as const, nativeQuiescence: "unproven" as const };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof Error && error.message === "QA_RUN_UNSAFE_PATH") throw error;
    throw new Error("QA_EVIDENCE_CORRUPT");
  }
}

/** Parse the fixed fixture from the exact bounded bytes whose digest is checked. */
export async function readVerifiedPublisherFixtureSnapshot(artifactPath: string, expectedDigest: string) {
  if (typeof artifactPath !== "string" || !isAbsolute(artifactPath)) throw new Error("QA_ARTIFACT_UNSAFE");
  let initial;
  try { initial = await lstat(artifactPath, { bigint: true }); } catch { throw new Error("QA_ARTIFACT_UNSAFE"); }
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size > limit) throw new Error("QA_ARTIFACT_UNSAFE");
  let handle;
  try { handle = await open(artifactPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { throw new Error("QA_ARTIFACT_UNSAFE"); }
  let bytes: Buffer;
  try {
    const before = await handle.stat({ bigint: true });
    const same = (value: typeof before) => value.isFile() && !value.isSymbolicLink() && value.dev === before.dev && value.ino === before.ino
      && value.size === before.size && value.mtimeNs === before.mtimeNs && value.ctimeNs === before.ctimeNs;
    if (before.size > limit || !same(initial)) throw new Error("QA_ARTIFACT_CHANGED");
    bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error("QA_ARTIFACT_CHANGED");
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    let current;
    try { current = await lstat(artifactPath, { bigint: true }); } catch { throw new Error("QA_ARTIFACT_CHANGED"); }
    if (!same(after) || !same(current)) throw new Error("QA_ARTIFACT_CHANGED");
  } finally { await handle.close(); }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expectedDigest) throw new Error("QA_ARTIFACT_DIGEST_MISMATCH");
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const snapshot = FcpxmlDocumentAdapter.readProjectFromContent(artifactPath, content, { allowMissingImmutableIdsForReadback: true });
    verifyAcceptanceFixture(snapshot);
    return snapshot;
  } catch { throw new Error("QA_PUBLISH_FIXTURE_MISMATCH"); }
}

/** Check the fixed publisher E2E fixture against the exact bytes hashed here; this does not authorize a handoff. */
export async function verifyQaPublisherFixture(root: string, qaRunId: string, artifactPath: string) {
  const run = await inspectRun(root, qaRunId);
  await assertQaJobIndex(root, run.manifest);
  await readVerifiedPublisherFixtureSnapshot(artifactPath, run.manifest.artifactDigest);
  const current = await inspectRun(root, qaRunId);
  await assertQaJobIndex(root, current.manifest);
  if (JSON.stringify(current) !== JSON.stringify(run)) throw new Error("QA_RUN_IDENTITY_MISMATCH");
  const record: FixtureRecord = { schemaVersion: 1, tier: "publisher-fixture", profile: "publisher-e2e-v1", result: "matched", artifactDigest: run.manifest.artifactDigest, checkedAt: new Date().toISOString() };
  try { await publishQaRecord(join(root, qaRunId, "publisher-fixture-evidence.json"), `${JSON.stringify(record)}\n`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const evidence = await readQaPublisherFixtureEvidence(root, qaRunId);
  if (!evidence) throw new Error("QA_EVIDENCE_CORRUPT");
  return evidence;
}
