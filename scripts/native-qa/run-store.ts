import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { publishQaRecord } from "./atomic-record.js";

export interface QaRunManifest {
  qaRunId: string;
  candidateCommit: string;
  candidateTree: string;
  packageDigest: string;
  mcpDigest: string;
  pluginDigest: string;
  extensionDigest: string;
  artifactDigest: string;
  sourceDigest: string;
  targetDigest: string;
  operation: "rough-cut-publish";
  authorizationDigest: string | null;
}
export interface QaRun {
  schemaVersion: 1;
  manifest: QaRunManifest;
  dispatch: "NOT_DISPATCHED" | "UNKNOWN_AFTER_DISPATCH";
  verdict: "BLOCKED";
  publishJobId?: string;
  authorizationBinding?: string;
}

const digestFields = ["packageDigest", "mcpDigest", "pluginDigest", "extensionDigest", "artifactDigest", "sourceDigest", "targetDigest"] as const;
const manifestFields = ["qaRunId", "candidateCommit", "candidateTree", ...digestFields, "authorizationDigest", "operation"] as const;

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function assertPrivateRoot(root: string): Promise<void> {
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || typeof process.getuid !== "function" || info.uid !== process.getuid()) throw new Error("unsafe");
  } catch { throw new Error("QA_RUN_ROOT_UNSAFE"); }
}
function validateId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error("QA_RUN_ID_INVALID");
}
function validateManifest(value: unknown): asserts value is QaRunManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("QA_RUN_MANIFEST_INVALID");
  const item = value as Record<string, unknown>;
  validateId(item.qaRunId);
  if (Object.keys(item).length !== manifestFields.length || manifestFields.some(key => !(key in item))) throw new Error("QA_RUN_MANIFEST_INVALID");
  if (![item.candidateCommit, item.candidateTree].every(value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value))) throw new Error("QA_RUN_MANIFEST_INVALID");
  if (digestFields.some(key => typeof item[key] !== "string" || !/^[a-f0-9]{64}$/.test(item[key] as string)) || (item.authorizationDigest !== null && (typeof item.authorizationDigest !== "string" || !/^[a-f0-9]{64}$/.test(item.authorizationDigest))) || item.operation !== "rough-cut-publish") throw new Error("QA_RUN_MANIFEST_INVALID");
}

export async function inspectRun(root: string, qaRunId: string): Promise<QaRun> {
  validateId(qaRunId);
  await assertPrivateRoot(root);
  try {
    const directory = await lstat(join(root, qaRunId));
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("QA_RUN_UNSAFE_PATH");
    const file = await lstat(join(root, qaRunId, "run.json"));
    if (!file.isFile() || file.isSymbolicLink()) throw new Error("QA_RUN_UNSAFE_PATH");
    const value: unknown = JSON.parse(await readFile(join(root, qaRunId, "run.json"), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    let run = value as QaRun;
    if (Object.keys(run).length !== 4 || run.schemaVersion !== 1 || run.dispatch !== "NOT_DISPATCHED" || run.verdict !== "BLOCKED") throw new Error("invalid");
    validateManifest(run.manifest);
    if (run.manifest.qaRunId !== qaRunId) throw new Error("invalid");
    try {
      const bindingPath = join(root, qaRunId, "authorization-binding.json");
      const bindingFile = await lstat(bindingPath);
      if (!bindingFile.isFile() || bindingFile.isSymbolicLink()) throw new Error("QA_RUN_UNSAFE_PATH");
      const binding: unknown = JSON.parse(await readFile(bindingPath, "utf8"));
      if (!binding || typeof binding !== "object" || Array.isArray(binding)) throw new Error("invalid");
      const item = binding as Record<string, unknown>;
      if (run.manifest.authorizationDigest !== null || Object.keys(item).sort().join(",") !== "authorizationDigest,schemaVersion" || item.schemaVersion !== 1 || typeof item.authorizationDigest !== "string" || !/^[a-f0-9]{64}$/.test(item.authorizationDigest)) throw new Error("invalid");
      await assertAuthorizationBinding(root, { ...run.manifest, authorizationDigest: item.authorizationDigest });
      run = { ...run, authorizationBinding: item.authorizationDigest };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      const marker = await lstat(join(root, qaRunId, "dispatch-uncertain"));
      if (!marker.isFile() || marker.isSymbolicLink()) throw new Error("QA_RUN_UNSAFE_PATH");
      let publishJobId: string | undefined;
      try {
        const intent: unknown = JSON.parse(await readFile(join(root, qaRunId, "dispatch-uncertain"), "utf8"));
        if (intent && typeof intent === "object" && !Array.isArray(intent)) {
          const record = intent as Record<string, unknown>;
          if (Object.keys(record).length === 1 && typeof record.publishJobId === "string" && /^[a-z0-9][a-z0-9-]{0,127}$/.test(record.publishJobId)) publishJobId = record.publishJobId;
        }
      } catch { /* An incomplete marker still blocks dispatch and replay. */ }
      return { ...run, dispatch: "UNKNOWN_AFTER_DISPATCH", ...(publishJobId ? { publishJobId } : {}) };
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

async function assertAuthorizationBinding(root: string, manifest: QaRunManifest): Promise<void> {
  const directory = join(root, `.authorization-${manifest.authorizationDigest}`);
  try {
    const bindingDir = await lstat(directory);
    const bindingFile = await lstat(join(directory, "run-id"));
    if (!bindingDir.isDirectory() || bindingDir.isSymbolicLink() || !bindingFile.isFile() || bindingFile.isSymbolicLink()) throw new Error("invalid");
    if (await readFile(join(directory, "run-id"), "utf8") !== `${manifest.qaRunId}\n`) throw new Error("invalid");
  } catch { throw new Error("QA_AUTHORIZATION_BINDING_INVALID"); }
}

function jobIdentity(manifest: QaRunManifest): unknown[] {
  return manifestFields.filter(key => key !== "qaRunId" && key !== "authorizationDigest").map(key => manifest[key]);
}
function jobIndexName(manifest: QaRunManifest): string {
  return `.job-${createHash("sha256").update(JSON.stringify(jobIdentity(manifest))).digest("hex")}`;
}
async function assertJobIndex(root: string, manifest: QaRunManifest): Promise<void> {
  const directory = join(root, jobIndexName(manifest));
  try {
    const index = await lstat(directory);
    const binding = await lstat(join(directory, "run-id"));
    if (!index.isDirectory() || index.isSymbolicLink() || !binding.isFile() || binding.isSymbolicLink()) throw new Error("invalid");
    if (await readFile(join(directory, "run-id"), "utf8") !== `${manifest.qaRunId}\n`) throw new Error("invalid");
  } catch { throw new Error("QA_INDEX_RECONCILIATION_REQUIRED"); }
}

async function reserveIndex(root: string, name: string, runId: string): Promise<string | undefined> {
  const directory = join(root, name);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      const index = await lstat(directory);
      const binding = await lstat(join(directory, "run-id"));
      if (!index.isDirectory() || index.isSymbolicLink() || !binding.isFile() || binding.isSymbolicLink()) throw new Error("QA_RUN_UNSAFE_PATH");
      const content = await readFile(join(directory, "run-id"), "utf8");
      if (!/^[a-z0-9][a-z0-9-]{0,63}\n$/.test(content)) throw new Error("QA_RUN_NOT_FOUND_OR_INCOMPLETE");
      return content.slice(0, -1);
    } catch (bindingError) {
      if ((bindingError as NodeJS.ErrnoException).code === "ENOENT") throw new Error("QA_RUN_NOT_FOUND_OR_INCOMPLETE");
      throw bindingError;
    }
  }
  const file = await open(join(directory, "run-id"), "wx", 0o600);
  try { await file.writeFile(`${runId}\n`); await file.sync(); }
  finally { await file.close(); }
  await syncDirectory(directory);
  await syncDirectory(root);
  return undefined;
}

/** Creates only a blocked record. It never initiates or resumes a native operation. */
export async function createOrInspectRun(root: string, manifest: QaRunManifest): Promise<{ created: boolean; run: QaRun }> {
  const bound = structuredClone(manifest);
  validateManifest(bound);
  await assertPrivateRoot(root);
  const directory = join(root, bound.qaRunId);
  const inspectMatching = async (runId: string): Promise<{ created: false; run: QaRun }> => {
    const run = await inspectRun(root, runId);
    const changed = manifestFields.some(key => key !== "qaRunId" && key !== "authorizationDigest" && run.manifest[key] !== bound[key]);
    const recordedDigest = run.manifest.authorizationDigest ?? run.authorizationBinding ?? null;
    const authorizationChanged = bound.authorizationDigest === null
      ? run.manifest.authorizationDigest !== null
      : recordedDigest !== bound.authorizationDigest;
    if (changed || authorizationChanged) throw new Error("QA_RUN_IDENTITY_MISMATCH");
    return { created: false, run };
  };
  try {
    await lstat(directory);
    return await inspectMatching(bound.qaRunId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const identity = jobIdentity(bound);
  const existingJob = await reserveIndex(root, jobIndexName(bound), bound.qaRunId);
  if (existingJob) return inspectMatching(existingJob);
  // An absent index can be a lost or older record, not proof that a job never existed.
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length > 1024) throw new Error("QA_INDEX_RECONCILIATION_REQUIRED");
  for (const entry of entries) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.name) || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    let previous: QaRun;
    try { previous = await inspectRun(root, entry.name); }
    catch { throw new Error("QA_INDEX_RECONCILIATION_REQUIRED"); }
    const previousIdentity = jobIdentity(previous.manifest);
    if (JSON.stringify(previousIdentity) === JSON.stringify(identity)) throw new Error("QA_INDEX_RECONCILIATION_REQUIRED");
  }
  if (bound.authorizationDigest !== null) {
    const existingApproval = await reserveIndex(root, `.authorization-${bound.authorizationDigest}`, bound.qaRunId);
    if (existingApproval) return inspectMatching(existingApproval);
  }
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return inspectMatching(bound.qaRunId);
  }
  const run: QaRun = { schemaVersion: 1, manifest: bound, dispatch: "NOT_DISPATCHED", verdict: "BLOCKED" };
  const file = await open(join(directory, "run.json"), "wx", 0o600);
  try { await file.writeFile(JSON.stringify(run) + "\n"); await file.sync(); }
  finally { await file.close(); }
  await syncDirectory(directory);
  await syncDirectory(root);
  return { created: true, run };
}


/** Record an externally supplied approval digest; this does not grant consent or dispatch. */
export async function bindQaAuthorization(root: string, manifest: QaRunManifest, digest: string): Promise<{ bound: boolean; run: QaRun }> {
  const bound = structuredClone(manifest);
  validateManifest(bound);
  if (bound.authorizationDigest !== null) throw new Error("QA_AUTHORIZATION_ALREADY_DECLARED");
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("QA_AUTHORIZATION_DIGEST_INVALID");
  const run = await inspectRun(root, bound.qaRunId);
  if (manifestFields.some(key => run.manifest[key] !== bound[key])) throw new Error("QA_RUN_IDENTITY_MISMATCH");
  if (run.authorizationBinding) {
    if (run.authorizationBinding !== digest) throw new Error("QA_RUN_IDENTITY_MISMATCH");
    return { bound: false, run };
  }
  if (run.dispatch !== "NOT_DISPATCHED") throw new Error("QA_DISPATCH_ALREADY_CLAIMED");
  await assertJobIndex(root, bound);
  const authorizationDirectory = join(root, `.authorization-${digest}`);
  try { await mkdir(authorizationDirectory, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let owner: string;
    try {
      const bindingDir = await lstat(authorizationDirectory);
      const bindingFile = await lstat(join(authorizationDirectory, "run-id"));
      if (!bindingDir.isDirectory() || bindingDir.isSymbolicLink() || !bindingFile.isFile() || bindingFile.isSymbolicLink()) throw new Error("QA_RUN_UNSAFE_PATH");
      const content = await readFile(join(authorizationDirectory, "run-id"), "utf8");
      if (!/^[a-z0-9][a-z0-9-]{0,63}\n$/.test(content)) throw new Error("QA_AUTHORIZATION_BINDING_INCOMPLETE");
      owner = content.slice(0, -1);
    } catch (bindingError) {
      if ((bindingError as NodeJS.ErrnoException).code === "ENOENT") throw new Error("QA_AUTHORIZATION_BINDING_INCOMPLETE");
      throw bindingError;
    }
    const original = await inspectRun(root, owner);
    if (manifestFields.some(key => key !== "qaRunId" && key !== "authorizationDigest" && original.manifest[key] !== bound[key])) throw new Error("QA_RUN_IDENTITY_MISMATCH");
    if ((original.manifest.authorizationDigest ?? original.authorizationBinding) !== digest) throw new Error("QA_AUTHORIZATION_BINDING_INCOMPLETE");
    return { bound: false, run: original };
  }
  await syncDirectory(root);
  await publishQaRecord(join(authorizationDirectory, "run-id"), `${bound.qaRunId}\n`);
  try {
    await publishQaRecord(join(root, bound.qaRunId, "authorization-binding.json"), `${JSON.stringify({ schemaVersion: 1, authorizationDigest: digest })}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await inspectRun(root, bound.qaRunId);
    if (existing.authorizationBinding !== digest) throw new Error("QA_RUN_IDENTITY_MISMATCH");
    return { bound: false, run: existing };
  }
  return { bound: true, run: await inspectRun(root, bound.qaRunId) };
}

/** Conservatively record uncertainty; this function never authorizes or dispatches native work. */
export async function markDispatchUncertain(root: string, manifest: QaRunManifest): Promise<QaRun> {
  const bound = structuredClone(manifest);
  validateManifest(bound);
  const existing = await inspectRun(root, bound.qaRunId);
  if (manifestFields.some(key => existing.manifest[key] !== bound[key])) throw new Error("QA_RUN_IDENTITY_MISMATCH");
  if (existing.dispatch === "UNKNOWN_AFTER_DISPATCH") return existing;
  const directory = join(root, bound.qaRunId);
  let marker;
  try { marker = await open(join(directory, "dispatch-uncertain"), "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return inspectRun(root, bound.qaRunId);
    throw error;
  }
  try { await marker.writeFile("uncertain\n"); await marker.sync(); }
  finally { await marker.close(); }
  await syncDirectory(directory);
  return inspectRun(root, bound.qaRunId);
}

/** Persist one conservative publisher intent; this never dispatches or authorizes native work. */
export async function claimDispatchIntent(root: string, manifest: QaRunManifest, publishJobId: string): Promise<QaRun> {
  const bound = structuredClone(manifest);
  validateManifest(bound);
  if (typeof publishJobId !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(publishJobId)) throw new Error("QA_PUBLISH_JOB_ID_INVALID");
  const existing = await inspectRun(root, bound.qaRunId);
  if (manifestFields.some(key => existing.manifest[key] !== bound[key])) throw new Error("QA_RUN_IDENTITY_MISMATCH");
  const authorizationDigest = bound.authorizationDigest ?? existing.authorizationBinding;
  if (!authorizationDigest) throw new Error("QA_AUTHORIZATION_REQUIRED");
  await assertJobIndex(root, bound);
  await assertAuthorizationBinding(root, { ...bound, authorizationDigest });
  const directory = join(root, bound.qaRunId);
  let marker;
  try { marker = await open(join(directory, "dispatch-uncertain"), "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("QA_DISPATCH_ALREADY_CLAIMED");
    throw error;
  }
  try { await marker.writeFile(JSON.stringify({ publishJobId }) + "\n"); await marker.sync(); }
  finally { await marker.close(); }
  await syncDirectory(directory);
  return inspectRun(root, bound.qaRunId);
}
