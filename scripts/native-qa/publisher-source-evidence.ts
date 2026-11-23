import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publishQaRecord } from "./atomic-record.js";
import { readVerifiedPublisherFixtureSnapshot } from "./publisher-fixture-evidence.js";
import { assertQaJobIndex, inspectRun } from "./run-store.js";

const fileLimit = 512n * 1024n * 1024n;
const totalLimit = 1024n * 1024n * 1024n;
type SourceRecord = { schemaVersion: 1; tier: "publisher-sources"; profile: "publisher-e2e-v1"; result: "matched"; artifactDigest: string; sourceDigest: string; sourceCount: 4; checkedAt: string };

/** Read a historical source snapshot; it is neither current-source nor native-quiescence proof. */
export async function readQaPublisherSourceEvidence(root: string, qaRunId: string) {
  const run = await inspectRun(root, qaRunId);
  const path = join(root, qaRunId, "publisher-source-evidence.json");
  try {
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error("QA_RUN_UNSAFE_PATH");
    if (file.size > 4096) throw new Error("invalid");
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    const item = value as Record<string, unknown>;
    if (Object.keys(item).sort().join(",") !== "artifactDigest,checkedAt,profile,result,schemaVersion,sourceCount,sourceDigest,tier"
      || item.schemaVersion !== 1 || item.tier !== "publisher-sources" || item.profile !== "publisher-e2e-v1" || item.result !== "matched"
      || item.sourceCount !== 4 || item.artifactDigest !== run.manifest.artifactDigest || item.sourceDigest !== run.manifest.sourceDigest
      || typeof item.checkedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(item.checkedAt)
      || !Number.isFinite(Date.parse(item.checkedAt)) || new Date(item.checkedAt).toISOString() !== item.checkedAt) throw new Error("invalid");
    return { ...item as unknown as SourceRecord, scope: "snapshot-only" as const, dispatchAllowed: false as const, nativeQuiescence: "unproven" as const };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof Error && error.message === "QA_RUN_UNSAFE_PATH") throw error;
    throw new Error("QA_EVIDENCE_CORRUPT");
  }
}

/** Compare the four fixture sources with the separately supplied manifest digest, without authorizing native work. */
export async function verifyQaPublisherSources(root: string, qaRunId: string, artifactPath: string) {
  const run = await inspectRun(root, qaRunId);
  await assertQaJobIndex(root, run.manifest);
  const snapshot = await readVerifiedPublisherFixtureSnapshot(artifactPath, run.manifest.artifactDigest);
  if (snapshot.media.length !== 4) throw new Error("QA_SOURCE_UNSAFE");
  const entries: Array<{ mediaId: string; source: string; sha256: string }> = [];
  const ids = new Set<string>(); const paths = new Set<string>();
  let total = 0n;
  for (const media of snapshot.media) {
    if (!media.mediaId || ids.has(media.mediaId) || typeof media.source !== "string" || !media.source) throw new Error("QA_SOURCE_UNSAFE");
    ids.add(media.mediaId);
    let source = media.source;
    try {
      if (source.startsWith("file:")) {
        const url = new URL(source);
        if (url.protocol !== "file:" || url.search || url.hash) throw new Error("invalid");
        source = fileURLToPath(url);
      }
      if (!isAbsolute(source) || source.includes("\0") || resolve(source) !== source || paths.has(source)) throw new Error("invalid");
    } catch { throw new Error("QA_SOURCE_UNSAFE"); }
    paths.add(source);
    let initial;
    try { initial = await lstat(source, { bigint: true }); } catch { throw new Error("QA_SOURCE_UNSAFE"); }
    if (!initial.isFile() || initial.isSymbolicLink() || initial.size > fileLimit || total + initial.size > totalLimit) throw new Error("QA_SOURCE_UNSAFE");
    let handle;
    try { handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { throw new Error("QA_SOURCE_UNSAFE"); }
    try {
      const before = await handle.stat({ bigint: true });
      const same = (value: typeof before) => value.isFile() && !value.isSymbolicLink() && value.dev === before.dev && value.ino === before.ino
        && value.size === before.size && value.mtimeNs === before.mtimeNs && value.ctimeNs === before.ctimeNs;
      if (!same(initial) || before.size > fileLimit || total + before.size > totalLimit) throw new Error("QA_SOURCE_CHANGED");
      const hash = createHash("sha256"); const buffer = Buffer.allocUnsafe(64 * 1024); let count = 0n;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        count += BigInt(bytesRead);
        if (count > before.size || count > fileLimit || total + count > totalLimit) throw new Error("QA_SOURCE_CHANGED");
        hash.update(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat({ bigint: true });
      let named;
      try { named = await lstat(source, { bigint: true }); } catch { throw new Error("QA_SOURCE_CHANGED"); }
      if (count !== before.size || !same(after) || !same(named)) throw new Error("QA_SOURCE_CHANGED");
      total += count; entries.push({ mediaId: media.mediaId, source, sha256: hash.digest("hex") });
    } finally { await handle.close(); }
  }
  entries.sort((a, b) => a.mediaId < b.mediaId ? -1 : a.mediaId > b.mediaId ? 1 : 0);
  const digest = createHash("sha256").update(JSON.stringify({ profile: "publisher-e2e-v1", sources: entries })).digest("hex");
  if (digest !== run.manifest.sourceDigest) throw new Error("QA_SOURCE_DIGEST_MISMATCH");
  const current = await inspectRun(root, qaRunId);
  await assertQaJobIndex(root, current.manifest);
  if (JSON.stringify(current) !== JSON.stringify(run)) throw new Error("QA_RUN_IDENTITY_MISMATCH");
  const record: SourceRecord = { schemaVersion: 1, tier: "publisher-sources", profile: "publisher-e2e-v1", result: "matched", artifactDigest: run.manifest.artifactDigest, sourceDigest: digest, sourceCount: 4, checkedAt: new Date().toISOString() };
  try { await publishQaRecord(join(root, qaRunId, "publisher-source-evidence.json"), `${JSON.stringify(record)}\n`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const evidence = await readQaPublisherSourceEvidence(root, qaRunId);
  if (!evidence) throw new Error("QA_EVIDENCE_CORRUPT");
  return evidence;
}
