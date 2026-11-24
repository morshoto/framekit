import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publishQaRecord } from "./atomic-record.js";
import { readQaRecord } from "./read-record.js";
import { assertQaHeadlessProfile, assertQaJobIndex, createOrInspectRun, inspectRun, type QaRunManifest } from "./run-store.js";
import { publisherTargetDigest, runSupervisedQaPublisherSimulation, type QaPublisherTarget } from "./publisher-supervision.js";
import { readQaPublisherStages } from "./publisher-stages.js";

type Mode = "pending" | "accepted-response-lost" | "intent-before-dispatch";
export interface QaPublisherSimulationSpec { artifactPath: string; target: QaPublisherTarget; mode: Mode }
const worker = fileURLToPath(new URL("./publisher-simulation-worker.ts", import.meta.url));
const checkout = fileURLToPath(new URL("../../", import.meta.url));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function validateSpec(value: QaPublisherSimulationSpec): QaPublisherSimulationSpec {
  const spec = structuredClone(value);
  if (!spec || typeof spec !== "object" || Array.isArray(spec) || Object.keys(spec).sort().join(",") !== "artifactPath,mode,target"
    || typeof spec.artifactPath !== "string" || !isAbsolute(spec.artifactPath) || resolve(spec.artifactPath) !== spec.artifactPath
    || spec.artifactPath.length > 4096 || spec.artifactPath.includes("\0")
    || (spec.mode !== "pending" && spec.mode !== "accepted-response-lost" && spec.mode !== "intent-before-dispatch")) {
    throw new Error("QA_SIMULATION_INPUT_INVALID");
  }
  publisherTargetDigest(spec.target);
  return spec;
}
function requestDigest(spec: QaPublisherSimulationSpec): string {
  return hash(JSON.stringify({ artifactPath: spec.artifactPath, targetDigest: publisherTargetDigest(spec.target), mode: spec.mode }));
}
async function readRequest(root: string, runId: string): Promise<{ schemaVersion: 1; digest: string }> {
  try {
    const item: unknown = JSON.parse(await readQaRecord(join(root, runId, "simulation-request.json")));
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).sort().join(",") !== "digest,schemaVersion"
      || (item as { schemaVersion?: unknown }).schemaVersion !== 1 || typeof (item as { digest?: unknown }).digest !== "string"
      || !/^[a-f0-9]{64}$/.test((item as { digest: string }).digest)) throw new Error("invalid");
    return item as { schemaVersion: 1; digest: string };
  } catch { throw new Error("QA_SIMULATION_REQUEST_CORRUPT"); }
}

/** Start only an isolated fake receiver; duplicate requests never launch another worker. */
export async function startQaPublisherSimulation(root: string, manifest: QaRunManifest, input: QaPublisherSimulationSpec) {
  const spec = validateSpec(input);
  const boundRoot = resolve(root);
  if (publisherTargetDigest(spec.target) !== manifest.targetDigest) throw new Error("QA_RUN_TARGET_MISMATCH");
  const outcome = await createOrInspectRun(boundRoot, manifest, "publisher-simulation-v1");
  const runId = outcome.run.manifest.qaRunId;
  const digest = requestDigest(spec);
  if (!outcome.created) {
    const existing = await readRequest(boundRoot, runId);
    if (existing.digest !== digest) throw new Error("QA_SIMULATION_IDENTITY_MISMATCH");
    return { scheduled: false, qaRunId: runId, scope: "simulated-receiver" as const, verdict: "BLOCKED" as const, dispatchAllowed: false as const };
  }
  await publishQaRecord(join(boundRoot, runId, "simulation-request.json"), `${JSON.stringify({ schemaVersion: 1, digest })}\n`);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("FRAMEKIT_FINAL_CUT_") && key !== "NODE_OPTIONS" && key !== "NODE_PATH"));
  const child = spawn(process.execPath, ["--import", "tsx", worker, boundRoot, runId], {
    cwd: checkout, detached: true, stdio: ["pipe", "ignore", "ignore"],
    env: { ...environment, FRAMEKIT_EDITOR: "memory", FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0", FRAMEKIT_AUTO_CONNECT: "0", FRAMEKIT_FINAL_CUT_HEADLESS: "1" },
  });
  await new Promise<void>((done, reject) => {
    child.once("error", reject);
    child.once("spawn", () => {
      if (!child.stdin) { reject(new Error("QA_SIMULATION_INPUT_INVALID")); return; }
      child.stdin.once("error", reject); child.stdin.end(JSON.stringify(spec), done);
    });
  });
  child.unref();
  return { scheduled: true, qaRunId: runId, scope: "simulated-receiver" as const, verdict: "BLOCKED" as const, dispatchAllowed: false as const };
}

/** A historical fixture result never establishes native receiver completion. */
export async function readQaPublisherSimulation(root: string, runId: string) {
  const run = await inspectRun(root, runId);
  assertQaHeadlessProfile(run, "publisher-simulation-v1");
  await assertQaJobIndex(root, run.manifest);
  const request = await readRequest(root, runId);
  let workerStarted = false;
  try {
    const claim: unknown = JSON.parse(await readQaRecord(join(root, runId, "simulation-worker-started.json")));
    if (!claim || typeof claim !== "object" || Array.isArray(claim) || Object.keys(claim).sort().join(",") !== "requestDigest,schemaVersion"
      || (claim as { schemaVersion?: unknown }).schemaVersion !== 1 || (claim as { requestDigest?: unknown }).requestDigest !== request.digest) throw new Error("invalid");
    workerStarted = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("QA_SIMULATION_RESULT_CORRUPT");
  }
  let value: unknown;
  try { value = JSON.parse(await readQaRecord(join(root, runId, "simulation-result.json"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "pending-or-interrupted" as const, scope: "simulated-receiver" as const, verdict: "BLOCKED" as const, dispatchAllowed: false as const };
    throw new Error("QA_SIMULATION_RESULT_CORRUPT");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("QA_SIMULATION_RESULT_CORRUPT");
  const item = value as Record<string, unknown>;
  const history = await readQaPublisherStages(root, runId);
  if (!workerStarted || Object.keys(item).sort().join(",") !== "requestDigest,schemaVersion,status" || item.schemaVersion !== 1 || item.requestDigest !== request.digest
    || !["verification-pending", "dispatch-outcome-unknown", "preflight-blocked"].includes(item.status as string)
    || (item.status === "verification-pending" && (run.dispatch !== "UNKNOWN_AFTER_DISPATCH" || history.stages[1]?.stage !== "dispatched"))
    || (item.status === "dispatch-outcome-unknown" && (run.dispatch !== "UNKNOWN_AFTER_DISPATCH" || history.stages.length < 1 || history.stages.length > 2))
    || (item.status === "preflight-blocked" && run.dispatch !== "NOT_DISPATCHED")) throw new Error("QA_SIMULATION_RESULT_CORRUPT");
  return { status: item.status as "verification-pending" | "dispatch-outcome-unknown" | "preflight-blocked", scope: "simulated-receiver" as const,
    verdict: "BLOCKED" as const, nativeQuiescence: "unproven" as const, dispatchAllowed: false as const };
}

/** Worker entry: the injected publisher is a fixed in-process simulation, never a native adapter. */
export async function performQaPublisherSimulation(root: string, runId: string, input: QaPublisherSimulationSpec): Promise<void> {
  const spec = validateSpec(input);
  const run = await inspectRun(root, runId);
  assertQaHeadlessProfile(run, "publisher-simulation-v1");
  await assertQaJobIndex(root, run.manifest);
  const request = await readRequest(root, runId);
  if (request.digest !== requestDigest(spec) || publisherTargetDigest(spec.target) !== run.manifest.targetDigest) throw new Error("QA_SIMULATION_IDENTITY_MISMATCH");
  try { await publishQaRecord(join(root, runId, "simulation-worker-started.json"), `${JSON.stringify({ schemaVersion: 1, requestDigest: request.digest })}\n`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return; throw error; }
  let status: "verification-pending" | "dispatch-outcome-unknown" | "preflight-blocked" = "preflight-blocked";
  try {
    await runSupervisedQaPublisherSimulation(root, run.manifest, spec.artifactPath, spec.target, spec.mode);
    status = "verification-pending";
  } catch {
    const observed = await inspectRun(root, runId);
    status = observed.dispatch === "UNKNOWN_AFTER_DISPATCH" ? "dispatch-outcome-unknown" : "preflight-blocked";
  }
  await publishQaRecord(join(root, runId, "simulation-result.json"), `${JSON.stringify({ schemaVersion: 1, requestDigest: request.digest, status })}\n`);
}
