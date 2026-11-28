import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { claimDispatchIntent, inspectRun, type QaRunManifest } from "./run-store.js";
import { readQaPublisherStages, recordQaPublisherStage } from "./publisher-stages.js";
import { verifyQaPublisherSourcesWithEntries } from "./publisher-source-evidence.js";
import { publishQaRecord } from "./atomic-record.js";
import { readQaRecord } from "./read-record.js";

export interface QaPublisherTarget {
  libraryPath: string;
  projectId: string;
  sequenceId: string;
  revisionId: string;
}

/** Bind the intended destination and baseline; this does not independently observe Final Cut. */
export function publisherTargetDigest(target: QaPublisherTarget): string {
  if (!target || typeof target !== "object" || Array.isArray(target)
    || Object.keys(target).sort().join(",") !== "libraryPath,projectId,revisionId,sequenceId"
    || typeof target.libraryPath !== "string" || !isAbsolute(target.libraryPath)
    || resolve(target.libraryPath) !== target.libraryPath || target.libraryPath.length > 4096 || target.libraryPath.includes("\0")
    || [target.projectId, target.sequenceId, target.revisionId].some(value => typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > 512 || value.includes("\0"))) {
    throw new Error("QA_RUN_TARGET_MISMATCH");
  }
  return createHash("sha256").update(JSON.stringify({ schemaVersion: 1, operation: "rough-cut-publish",
    libraryPath: target.libraryPath, projectId: target.projectId, sequenceId: target.sequenceId, revisionId: target.revisionId })).digest("hex");
}

/** Run only the fixed fake publisher for a simulation-profile run; no caller supplies native callbacks. */
export async function runSupervisedQaPublisherSimulation(
  root: string, manifest: QaRunManifest, artifactPath: string, target: QaPublisherTarget,
  mode: "pending" | "accepted-response-lost" | "intent-before-dispatch",
): Promise<unknown> {
  const bound = structuredClone(manifest);
  const boundTarget = structuredClone(target);
  const run = await inspectRun(root, bound.qaRunId);
  if (run.headlessProfile !== "publisher-simulation-v1") throw new Error("QA_WORKER_PROFILE_MISMATCH");
  if (JSON.stringify(run.manifest) !== JSON.stringify(bound)) throw new Error("QA_RUN_IDENTITY_MISMATCH");
  if (publisherTargetDigest(boundTarget) !== bound.targetDigest) throw new Error("QA_RUN_TARGET_MISMATCH");
  if (mode !== "pending" && mode !== "accepted-response-lost" && mode !== "intent-before-dispatch") throw new Error("QA_SIMULATION_INPUT_INVALID");
  const sources = await verifyQaPublisherSourcesWithEntries(root, bound.qaRunId, artifactPath);
  const jobId = `simulation-${createHash("sha256").update(bound.qaRunId).digest("hex").slice(0, 24)}`;
  const preview = { jobId, state: "awaiting-confirmation", artifactDigest: bound.artifactDigest,
    targetLibraryPath: boundTarget.libraryPath, sourceProof: { sourceMediaDigests: sources.sourceDigests } };
  await recordQaPublisherStage(root, bound.qaRunId, "prepared", preview);
  // Recheck fixture bytes before reserving the simulated dispatch. The fake
  // receiver is built in; no caller can provide a publisher or readiness gate.
  await verifyQaPublisherSourcesWithEntries(root, bound.qaRunId, artifactPath);
  await claimDispatchIntent(root, bound, jobId);
  if (mode === "intent-before-dispatch") throw new Error("simulated interruption after durable intent");
  if (mode === "accepted-response-lost") throw new Error("simulated response loss after acceptance");
  const dispatched = { jobId, state: "verification-pending", nextAction: "confirm-verification", delivery: { status: "dispatched" } };
  await recordQaPublisherStage(root, bound.qaRunId, "dispatched", dispatched);
  return dispatched;
}

/** A claim is only evidence of a possible attempt, never proof that readback started or finished. */
export async function readQaPublisherVerificationClaim(root: string, qaRunId: string) {
  const run = await inspectRun(root, qaRunId);
  const history = await readQaPublisherStages(root, qaRunId);
  let value: unknown;
  try { value = JSON.parse(await readQaRecord(join(root, qaRunId, "verification-attempt.json"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof Error && error.message === "QA_RUN_UNSAFE_PATH") throw error;
    throw new Error("QA_VERIFICATION_CLAIM_CORRUPT");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("QA_VERIFICATION_CLAIM_CORRUPT");
  const claim = value as Record<string, unknown>;
  if (Object.keys(claim).sort().join(",") !== "jobId,schemaVersion" || claim.schemaVersion !== 1
    || run.dispatch !== "UNKNOWN_AFTER_DISPATCH" || !run.publishJobId || claim.jobId !== run.publishJobId
    || history.stages.length < 2 || history.stages[1]?.stage !== "dispatched" || history.stages[1].jobId !== claim.jobId) {
    throw new Error("QA_VERIFICATION_CLAIM_CORRUPT");
  }
  return { jobId: run.publishJobId, status: history.stages.length === 3 ? "observation-recorded" as const : "claimed-outcome-unknown" as const,
    scope: "publisher-response-observation" as const, verdict: "BLOCKED" as const, nativeQuiescence: "unproven" as const, dispatchAllowed: false as const };
}
