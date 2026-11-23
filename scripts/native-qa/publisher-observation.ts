import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publishQaRecord } from "./atomic-record.js";
import { readQaRecord } from "./read-record.js";
import { assertQaJobIndex, inspectRun } from "./run-store.js";

const worker = fileURLToPath(new URL("./publisher-observation-worker.ts", import.meta.url));
const checkout = fileURLToPath(new URL("../../", import.meta.url));
const states = ["awaiting-confirmation", "awaiting-final-cut", "verification-pending", "verified", "failed"] as const;
type ObservedState = typeof states[number];
type Request = { schemaVersion: 1; observationId: string; directoryDigest: string; runDigest: string };
type Result = { schemaVersion: 1; observationId: string; runDigest: string; observedAt: string; nextAction: "inspect-recovery" | "status-unavailable" | "identity-mismatch"; observedState?: ObservedState };

function validateId(id: string): void {
  if (typeof id !== "string" || !/^status-(?:[0-9]|[12][0-9]|3[01])$/.test(id)) throw new Error("QA_OBSERVATION_ID_INVALID");
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function requestPath(root: string, runId: string, id: string): string { return join(root, runId, `publisher-observation-${id}.request.json`); }
function resultPath(root: string, runId: string, id: string): string { return join(root, runId, `publisher-observation-${id}.result.json`); }
async function boundRun(root: string, runId: string) {
  const run = await inspectRun(root, runId); await assertQaJobIndex(root, run.manifest);
  if (run.dispatch !== "UNKNOWN_AFTER_DISPATCH" || !run.publishJobId) throw new Error("QA_PUBLISH_STATUS_UNAVAILABLE");
  return { run, runDigest: digest(JSON.stringify(run)) };
}
async function readRequest(root: string, runId: string, id: string): Promise<Request> {
  try {
    const value: unknown = JSON.parse(await readQaRecord(requestPath(root, runId, id)));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    const item = value as Record<string, unknown>;
    if (Object.keys(item).sort().join(",") !== "directoryDigest,observationId,runDigest,schemaVersion"
      || item.schemaVersion !== 1 || item.observationId !== id || typeof item.directoryDigest !== "string" || !/^[a-f0-9]{64}$/.test(item.directoryDigest)
      || typeof item.runDigest !== "string" || !/^[a-f0-9]{64}$/.test(item.runDigest)) throw new Error("invalid");
    return item as unknown as Request;
  } catch { throw new Error("QA_OBSERVATION_CORRUPT"); }
}

/** Start one detached, status-only store read. Repeating an ID never launches another worker. */
export async function startQaPublisherObservation(root: string, runId: string, id: string, directory: string) {
  validateId(id);
  if (typeof directory !== "string" || !isAbsolute(directory) || directory.length > 4096 || directory.includes("\0")) throw new Error("QA_OBSERVATION_INPUT_INVALID");
  const boundRoot = resolve(root); const boundDirectory = resolve(directory);
  const { runDigest } = await boundRun(boundRoot, runId);
  const request: Request = { schemaVersion: 1, observationId: id, directoryDigest: digest(boundDirectory), runDigest };
  try { await publishQaRecord(requestPath(boundRoot, runId, id), `${JSON.stringify(request)}\n`); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readRequest(boundRoot, runId, id);
    if (JSON.stringify(existing) !== JSON.stringify(request)) throw new Error("QA_OBSERVATION_IDENTITY_MISMATCH");
    return { scheduled: false, verdict: "BLOCKED" as const, dispatchAllowed: false as const };
  }
  const child = spawn(process.execPath, ["--import", "tsx", worker, boundRoot, runId, id], {
    cwd: checkout, detached: true, stdio: ["pipe", "ignore", "ignore"],
    env: { ...process.env, FRAMEKIT_AUTO_CONNECT: "0", FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0" },
  });
  await new Promise<void>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("spawn", () => {
      if (!child.stdin) { reject(new Error("QA_OBSERVATION_INPUT_UNAVAILABLE")); return; }
      child.stdin.once("error", reject); child.stdin.end(JSON.stringify({ directory: boundDirectory }), resolvePromise);
    });
  });
  child.unref();
  return { scheduled: true, verdict: "BLOCKED" as const, dispatchAllowed: false as const };
}

/** A historical store observation is not a receiver receipt or native verification. */
export async function readQaPublisherObservation(root: string, runId: string, id: string) {
  validateId(id);
  const { run, runDigest } = await boundRun(root, runId);
  const request = await readRequest(root, runId, id);
  if (request.runDigest !== runDigest) throw new Error("QA_OBSERVATION_IDENTITY_MISMATCH");
  let value: unknown;
  try { value = JSON.parse(await readQaRecord(resultPath(root, runId, id))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "pending-or-interrupted" as const, observationId: id,
      dispatch: run.dispatch, verdict: "BLOCKED" as const, scope: "historical-publisher-store" as const,
      nativeQuiescence: "unproven" as const, dispatchAllowed: false as const };
    throw new Error("QA_OBSERVATION_CORRUPT");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("QA_OBSERVATION_CORRUPT");
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item).sort().join(",");
  if ((keys !== "nextAction,observationId,observedAt,runDigest,schemaVersion" && keys !== "nextAction,observationId,observedAt,observedState,runDigest,schemaVersion")
    || item.schemaVersion !== 1 || item.observationId !== id || item.runDigest !== runDigest || typeof item.observedAt !== "string"
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(item.observedAt) || !Number.isFinite(Date.parse(item.observedAt))
    || new Date(item.observedAt).toISOString() !== item.observedAt
    || (item.nextAction === "inspect-recovery" ? !states.includes(item.observedState as ObservedState)
      : (item.nextAction !== "status-unavailable" && item.nextAction !== "identity-mismatch") || item.observedState !== undefined)) throw new Error("QA_OBSERVATION_CORRUPT");
  return { ...item as unknown as Result, status: "recorded" as const, jobId: run.publishJobId!, dispatch: run.dispatch, verdict: "BLOCKED" as const,
    scope: "historical-publisher-store" as const, nativeQuiescence: "unproven" as const, dispatchAllowed: false as const };
}

/** Recover the bounded set of historical observations without knowing the client request IDs. */
export async function readQaPublisherObservations(root: string, runId: string) {
  await inspectRun(root, runId);
  const exists = async (path: string) => {
    try { await lstat(path); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  };
  const observations: Awaited<ReturnType<typeof readQaPublisherObservation>>[] = [];
  for (let index = 0; index < 32; index++) {
    const id = `status-${index}`;
    const [request, result] = await Promise.all([exists(requestPath(root, runId, id)), exists(resultPath(root, runId, id))]);
    if (!request && result) throw new Error("QA_OBSERVATION_CORRUPT");
    if (request) observations.push(await readQaPublisherObservation(root, runId, id));
  }
  return observations;
}

/** Worker entry: read one store record and publish a sanitized, immutable observation. */
export async function performQaPublisherObservation(root: string, runId: string, id: string, directory: string): Promise<void> {
  validateId(id);
  if (!isAbsolute(directory) || directory.length > 4096 || directory.includes("\0")) throw new Error("QA_OBSERVATION_INPUT_INVALID");
  const request = await readRequest(root, runId, id);
  const { runDigest } = await boundRun(root, runId);
  if (request.runDigest !== runDigest || request.directoryDigest !== digest(resolve(directory))) throw new Error("QA_OBSERVATION_IDENTITY_MISMATCH");
  const { inspectQaPublisherFromStore } = await import("./publisher-inspection.js");
  let observed: Awaited<ReturnType<typeof inspectQaPublisherFromStore>> | undefined;
  let identityMismatch = false;
  try { observed = await inspectQaPublisherFromStore(root, runId, directory); }
  catch (error) { identityMismatch = error instanceof Error && error.message === "QA_PUBLISH_STATUS_IDENTITY_MISMATCH"; }
  const current = await boundRun(root, runId);
  if (current.runDigest !== runDigest) throw new Error("QA_OBSERVATION_IDENTITY_MISMATCH");
  const result: Result = { schemaVersion: 1, observationId: id, runDigest, observedAt: new Date().toISOString(),
    ...(identityMismatch ? { nextAction: "identity-mismatch" } : observed?.nextAction === "inspect-recovery" && "observedState" in observed
      ? { nextAction: "inspect-recovery", observedState: observed.observedState } : { nextAction: "status-unavailable" }) };
  await publishQaRecord(resultPath(root, runId, id), `${JSON.stringify(result)}\n`);
}
