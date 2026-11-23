import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface QaRunManifest {
  qaRunId: string;
  candidateCommit: string;
  candidateTree: string;
  packageDigest: string;
  pluginDigest: string;
  extensionDigest: string;
  artifactDigest: string;
  sourceDigest: string;
  targetDigest: string;
  operation: "rough-cut-publish";
  authorizationDigest: string;
}
export interface QaRun {
  schemaVersion: 1;
  manifest: QaRunManifest;
  dispatch: "NOT_DISPATCHED" | "UNKNOWN_AFTER_DISPATCH";
  verdict: "BLOCKED";
}

const digestFields = ["packageDigest", "pluginDigest", "extensionDigest", "artifactDigest", "sourceDigest", "targetDigest", "authorizationDigest"] as const;
const manifestFields = ["qaRunId", "candidateCommit", "candidateTree", ...digestFields, "operation"] as const;

function validateId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error("QA_RUN_ID_INVALID");
}
function validateManifest(value: unknown): asserts value is QaRunManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("QA_RUN_MANIFEST_INVALID");
  const item = value as Record<string, unknown>;
  validateId(item.qaRunId);
  if (Object.keys(item).length !== manifestFields.length || manifestFields.some(key => !(key in item))) throw new Error("QA_RUN_MANIFEST_INVALID");
  if (![item.candidateCommit, item.candidateTree].every(value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value))) throw new Error("QA_RUN_MANIFEST_INVALID");
  if (digestFields.some(key => typeof item[key] !== "string" || !/^[a-f0-9]{64}$/.test(item[key] as string)) || item.operation !== "rough-cut-publish") throw new Error("QA_RUN_MANIFEST_INVALID");
}

export async function inspectRun(root: string, qaRunId: string): Promise<QaRun> {
  validateId(qaRunId);
  try {
    const directory = await lstat(join(root, qaRunId));
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("QA_RUN_UNSAFE_PATH");
    const file = await lstat(join(root, qaRunId, "run.json"));
    if (!file.isFile() || file.isSymbolicLink()) throw new Error("QA_RUN_UNSAFE_PATH");
    const value: unknown = JSON.parse(await readFile(join(root, qaRunId, "run.json"), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    const run = value as QaRun;
    if (Object.keys(run).length !== 4 || run.schemaVersion !== 1 || run.dispatch !== "NOT_DISPATCHED" || run.verdict !== "BLOCKED") throw new Error("invalid");
    validateManifest(run.manifest);
    if (run.manifest.qaRunId !== qaRunId) throw new Error("invalid");
    try {
      const marker = await lstat(join(root, qaRunId, "dispatch-uncertain"));
      if (!marker.isFile() || marker.isSymbolicLink()) throw new Error("QA_RUN_UNSAFE_PATH");
      return { ...run, dispatch: "UNKNOWN_AFTER_DISPATCH" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return run;
  } catch (error) {
    if (error instanceof Error && error.message === "QA_RUN_UNSAFE_PATH") throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("QA_RUN_NOT_FOUND_OR_INCOMPLETE");
    throw new Error("QA_RUN_CORRUPT");
  }
}

/** Creates only a blocked record. It never initiates or resumes a native operation. */
export async function createOrInspectRun(root: string, manifest: QaRunManifest): Promise<{ created: boolean; run: QaRun }> {
  validateManifest(manifest);
  const directory = join(root, manifest.qaRunId);
  try { await mkdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const run = await inspectRun(root, manifest.qaRunId);
    if (manifestFields.some(key => run.manifest[key] !== manifest[key])) throw new Error("QA_RUN_IDENTITY_MISMATCH");
    return { created: false, run };
  }
  const run: QaRun = { schemaVersion: 1, manifest: { ...manifest }, dispatch: "NOT_DISPATCHED", verdict: "BLOCKED" };
  const file = await open(join(directory, "run.json"), "wx", 0o600);
  try { await file.writeFile(JSON.stringify(run) + "\n"); await file.sync(); }
  finally { await file.close(); }
  return { created: true, run };
}


/** Conservatively record uncertainty; this function never authorizes or dispatches native work. */
export async function markDispatchUncertain(root: string, manifest: QaRunManifest): Promise<QaRun> {
  validateManifest(manifest);
  const existing = await inspectRun(root, manifest.qaRunId);
  if (manifestFields.some(key => existing.manifest[key] !== manifest[key])) throw new Error("QA_RUN_IDENTITY_MISMATCH");
  if (existing.dispatch === "UNKNOWN_AFTER_DISPATCH") return existing;
  const directory = join(root, manifest.qaRunId);
  let marker;
  try { marker = await open(join(directory, "dispatch-uncertain"), "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return inspectRun(root, manifest.qaRunId);
    throw error;
  }
  try { await marker.writeFile("uncertain\n"); await marker.sync(); }
  finally { await marker.close(); }
  const directoryHandle = await open(directory, "r");
  try { await directoryHandle.sync(); }
  finally { await directoryHandle.close(); }
  return inspectRun(root, manifest.qaRunId);
}
