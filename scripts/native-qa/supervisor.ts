import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertQaJobIndex, createOrInspectRun, inspectRun, type QaRunManifest } from "./run-store.js";

const checkout = fileURLToPath(new URL("../../", import.meta.url));
const worker = join(dirname(fileURLToPath(import.meta.url)), "worker.ts");
const results = ["candidate-mismatch", "candidate-changed", "render-contract-passed", "render-contract-failed", "preflight-error"] as const;
export type HeadlessResult = typeof results[number];
export interface HeadlessEvidence {
  schemaVersion: 1;
  tier: "headless";
  result: HeadlessResult;
  startedAt: string;
  finishedAt: string;
}

async function launchHeadlessWorker(root: string, qaRunId: string): Promise<void> {
  const child = spawn(process.execPath, ["--import", "tsx", worker, root, qaRunId], {
    cwd: checkout, detached: true, stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  child.unref();
}

/** Start one bounded headless check only. A duplicate start never creates a worker. */
export async function startQaRun(root: string, manifest: QaRunManifest) {
  const boundRoot = resolve(root);
  const outcome = await createOrInspectRun(boundRoot, manifest);
  if (outcome.created) await launchHeadlessWorker(boundRoot, outcome.run.manifest.qaRunId);
  return outcome;
}

/** Explicitly reschedule only a not-yet-started headless check, never a native operation. */
export async function resumeHeadlessQaRun(root: string, qaRunId: string) {
  const boundRoot = resolve(root);
  const run = await inspectRun(boundRoot, qaRunId);
  if (run.dispatch !== "NOT_DISPATCHED") throw new Error("QA_DISPATCH_ALREADY_CLAIMED");
  await assertQaJobIndex(boundRoot, run.manifest);
  const evidence = await readQaEvidence(boundRoot, qaRunId);
  if (evidence.result !== "pending-or-interrupted" || evidence.startedAt) return { scheduled: false, dispatchAllowed: false };
  await launchHeadlessWorker(boundRoot, qaRunId);
  return { scheduled: true, dispatchAllowed: false };
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

/** Missing or partial evidence never establishes that a worker is running or that native work is safe. */
export async function readQaEvidence(root: string, qaRunId: string) {
  const run = await inspectRun(root, qaRunId);
  const directory = join(root, qaRunId);
  const path = join(directory, "headless-result.json");
  let startedAt: string | undefined;
  try {
    const marker = join(directory, "headless-started");
    const file = await lstat(marker);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error("QA_RUN_UNSAFE_PATH");
    const value: unknown = JSON.parse(await readFile(marker, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    const item = value as Record<string, unknown>;
    if (Object.keys(item).sort().join(",") !== "schemaVersion,startedAt" || item.schemaVersion !== 1 || !validTimestamp(item.startedAt)) throw new Error("invalid");
    startedAt = item.startedAt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof Error && error.message === "QA_RUN_UNSAFE_PATH") throw error;
      throw new Error("QA_EVIDENCE_CORRUPT");
    }
  }
  let evidence: HeadlessEvidence;
  try {
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error("QA_RUN_UNSAFE_PATH");
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    const item = value as Record<string, unknown>;
    if (Object.keys(item).sort().join(",") !== "finishedAt,result,schemaVersion,startedAt,tier"
      || item.schemaVersion !== 1 || item.tier !== "headless" || !results.includes(item.result as HeadlessResult)
      || !validTimestamp(item.startedAt) || !validTimestamp(item.finishedAt)
      || !startedAt || item.startedAt !== startedAt || item.finishedAt < item.startedAt) throw new Error("invalid");
    evidence = item as unknown as HeadlessEvidence;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { tier: "headless" as const, result: "pending-or-interrupted" as const, verdict: "BLOCKED" as const, dispatch: run.dispatch, ...(startedAt ? { startedAt } : {}) };
    if (error instanceof Error && error.message === "QA_RUN_UNSAFE_PATH") throw error;
    throw new Error("QA_EVIDENCE_CORRUPT");
  }
  return { ...evidence, verdict: "BLOCKED" as const, dispatch: run.dispatch };
}
