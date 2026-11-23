import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { publishQaRecord } from "./atomic-record.js";
import { readQaRecord } from "./read-record.js";
import { assertQaJobIndex, inspectRun } from "./run-store.js";

const exec = promisify(execFile);
const maxFiles = 4096;
const maxBytes = 128 * 1024 * 1024;
interface PluginRecord { schemaVersion: 1; tier: "plugin"; result: "digest-matched"; candidateCommit: string; candidateTree: string; pluginDigest: string; checkedAt: string }

/** Historical directory observation; it does not establish which plugin is active or authorize dispatch. */
export async function readQaPluginEvidence(root: string, qaRunId: string) {
  const run = await inspectRun(root, qaRunId);
  try {
    const value: unknown = JSON.parse(await readQaRecord(join(root, qaRunId, "plugin-evidence.json")));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    const item = value as Record<string, unknown>;
    if (Object.keys(item).sort().join(",") !== "candidateCommit,candidateTree,checkedAt,pluginDigest,result,schemaVersion,tier"
      || item.schemaVersion !== 1 || item.tier !== "plugin" || item.result !== "digest-matched"
      || item.candidateCommit !== run.manifest.candidateCommit || item.candidateTree !== run.manifest.candidateTree
      || item.pluginDigest !== run.manifest.pluginDigest || typeof item.checkedAt !== "string"
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(item.checkedAt)
      || !Number.isFinite(Date.parse(item.checkedAt)) || new Date(item.checkedAt).toISOString() !== item.checkedAt) throw new Error("invalid");
    return { ...item as unknown as PluginRecord, scope: "directory-snapshot" as const, dispatchAllowed: false as const };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("QA_EVIDENCE_CORRUPT");
  }
}

async function digestDirectory(root: string): Promise<{ digest: string; files: Array<{ path: string; blob: string; executable: boolean }> }> {
  const entries: Array<{ path: string; size: number; sha256: string; blob: string; executable: boolean }> = [];
  let total = 0; let nodes = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 64) throw new Error("QA_PLUGIN_UNSAFE");
    const dirInfo = await lstat(dir);
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) throw new Error("QA_PLUGIN_UNSAFE");
    const directory = await opendir(dir);
    for await (const entry of directory) {
      if (++nodes > maxFiles) throw new Error("QA_PLUGIN_UNSAFE");
      const path = join(dir, entry.name); const item = await lstat(path, { bigint: true });
      if (item.isDirectory() && !item.isSymbolicLink()) { await walk(path, depth + 1); continue; }
      if (!item.isFile() || item.isSymbolicLink() || item.size > BigInt(maxBytes) || entries.length >= maxFiles) throw new Error("QA_PLUGIN_UNSAFE");
      total += Number(item.size); if (total > maxBytes) throw new Error("QA_PLUGIN_UNSAFE");
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || before.dev !== item.dev || before.ino !== item.ino || before.size !== item.size || before.mtimeNs !== item.mtimeNs || before.ctimeNs !== item.ctimeNs) throw new Error("QA_PLUGIN_CHANGED");
        const hash = createHash("sha256"); const blob = createHash("sha1").update(`blob ${item.size}\0`); const buffer = Buffer.allocUnsafe(65536); let count = 0;
        while (true) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; count += bytesRead; if (count > Number(item.size)) throw new Error("QA_PLUGIN_CHANGED"); hash.update(buffer.subarray(0, bytesRead)); blob.update(buffer.subarray(0, bytesRead)); }
        const after = await handle.stat({ bigint: true });
        if (count !== Number(item.size) || after.size !== item.size || after.mtimeNs !== item.mtimeNs || after.ctimeNs !== item.ctimeNs) throw new Error("QA_PLUGIN_CHANGED");
        entries.push({ path: relative(root, path).split(sep).join("/"), size: count, sha256: hash.digest("hex"), blob: blob.digest("hex"), executable: (item.mode & 0o111n) !== 0n });
      } finally { await handle.close(); }
    }
  };
  await walk(root, 0); if (!entries.length) throw new Error("QA_PLUGIN_UNSAFE");
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const digest = createHash("sha256").update(JSON.stringify(entries.map(({ path, size, sha256 }) => ({ path, size, sha256 })))).digest("hex");
  return { digest, files: entries.map(({ path, blob, executable }) => ({ path, blob, executable })) };
}

/** Compare two bounded directory snapshots against a clean candidate; no native state is observed. */
export async function verifyQaPluginIdentity(root: string, qaRunId: string, input: { checkout: string; codexHome: string; installedPath: string }) {
  try { return await verifyQaPluginIdentityInner(root, qaRunId, input); }
  catch (error) {
    if (error instanceof Error && /^QA_[A-Z_]+$/.test(error.message)) throw error;
    throw new Error("QA_PLUGIN_UNAVAILABLE");
  }
}

async function verifyQaPluginIdentityInner(root: string, qaRunId: string, input: { checkout: string; codexHome: string; installedPath: string }) {
  const run = await inspectRun(root, qaRunId); await assertQaJobIndex(root, run.manifest);
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join(",") !== "checkout,codexHome,installedPath"
    || ![input.checkout, input.codexHome, input.installedPath].every((path) => typeof path === "string" && isAbsolute(path) && path.length <= 4096 && !path.includes("\0"))) throw new Error("QA_PLUGIN_UNSAFE");
  for (const path of [input.checkout, input.codexHome, input.installedPath]) { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("QA_PLUGIN_UNSAFE"); }
  const [checkout, home, installed] = await Promise.all([realpath(input.checkout), realpath(input.codexHome), realpath(input.installedPath)]);
  const child = relative(home, installed);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error("QA_PLUGIN_UNSAFE");
  const candidateMatches = async () => {
    const options = { cwd: checkout, timeout: 10000, maxBuffer: 1024 * 1024 };
    const [head, tree, status] = await Promise.all([exec("git", ["rev-parse", "HEAD"], options), exec("git", ["rev-parse", "HEAD^{tree}"], options), exec("git", ["-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=normal"], options)]);
    return head.stdout.trim() === run.manifest.candidateCommit && tree.stdout.trim() === run.manifest.candidateTree && !status.stdout.trim();
  };
  if (!await candidateMatches()) throw new Error("QA_CANDIDATE_MISMATCH");
  const sourceParent = join(checkout, "plugins");
  const sourceParentInfo = await lstat(sourceParent);
  if (!sourceParentInfo.isDirectory() || sourceParentInfo.isSymbolicLink()) throw new Error("QA_PLUGIN_UNSAFE");
  const source = join(sourceParent, "framekit");
  const first = await Promise.all([digestDirectory(source), digestDirectory(installed)]);
  const second = await Promise.all([digestDirectory(source), digestDirectory(installed)]);
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error("QA_PLUGIN_CHANGED");
  if (second[0]!.digest !== run.manifest.pluginDigest || second[1]!.digest !== run.manifest.pluginDigest) throw new Error("QA_PLUGIN_MISMATCH");
  const tree = await exec("git", ["ls-tree", "-rz", "--full-tree", "HEAD", "--", "plugins/framekit"],
    { cwd: checkout, timeout: 10000, maxBuffer: 1024 * 1024 });
  const tracked = tree.stdout.split("\0").filter(Boolean).map((line) => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\tplugins\/framekit\/(.+)$/s.exec(line);
    if (!match) throw new Error("QA_CANDIDATE_MISMATCH");
    return { path: match[3]!, blob: match[2]!, executable: match[1] === "100755" };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!tracked.length || JSON.stringify(tracked) !== JSON.stringify(second[0]!.files)
    || JSON.stringify(tracked) !== JSON.stringify(second[1]!.files)) throw new Error("QA_CANDIDATE_MISMATCH");
  if (!await candidateMatches()) throw new Error("QA_CANDIDATE_MISMATCH");
  const current = await inspectRun(root, qaRunId); await assertQaJobIndex(root, current.manifest);
  if (JSON.stringify(current) !== JSON.stringify(run)) throw new Error("QA_RUN_IDENTITY_MISMATCH");
  const record: PluginRecord = { schemaVersion: 1, tier: "plugin", result: "digest-matched", candidateCommit: run.manifest.candidateCommit,
    candidateTree: run.manifest.candidateTree, pluginDigest: run.manifest.pluginDigest, checkedAt: new Date().toISOString() };
  try { await publishQaRecord(join(root, qaRunId, "plugin-evidence.json"), `${JSON.stringify(record)}\n`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const observed = await readQaPluginEvidence(root, qaRunId); if (!observed) throw new Error("QA_EVIDENCE_CORRUPT");
  return observed;
}
