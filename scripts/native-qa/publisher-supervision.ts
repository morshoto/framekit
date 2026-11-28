import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { runPublishStages } from "../final-cut-publisher-verification.mjs";
import { claimDispatchIntent, inspectRun, type QaRunManifest } from "./run-store.js";
import { readQaPublisherStages, recordQaPublisherStage, type PublisherStage } from "./publisher-stages.js";
import { verifyQaPublisherSourcesWithEntries } from "./publisher-source-evidence.js";
import { publishQaRecord } from "./atomic-record.js";
import { readQaRecord } from "./read-record.js";

type PublisherInput = Parameters<typeof runPublishStages>[1];
type PublisherCall = Parameters<typeof runPublishStages>[0];

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

/** Internal orchestration seam. The caller must supply an independently verified readiness gate. */
export async function runSupervisedQaPublisher(
  root: string, manifest: QaRunManifest, input: PublisherInput, call: PublisherCall,
  assertReady: (jobId: string, target: Readonly<QaPublisherTarget>) => Promise<void>, target: QaPublisherTarget,
): Promise<unknown> {
  return runSupervisedQaPublisherInternal(root, manifest, input, call, assertReady, target, false);
}

async function runSupervisedQaPublisherInternal(
  root: string, manifest: QaRunManifest, input: PublisherInput, call: PublisherCall,
  assertReady: (jobId: string, target: Readonly<QaPublisherTarget>) => Promise<void>, target: QaPublisherTarget, simulation: boolean,
): Promise<unknown> {
  const bound = structuredClone(manifest);
  const request = structuredClone(input);
  const boundTarget = structuredClone(target);
  const run = await inspectRun(root, bound.qaRunId);
  if ((run.headlessProfile === "publisher-simulation-v1") !== simulation) throw new Error("QA_WORKER_PROFILE_MISMATCH");
  if (JSON.stringify(run.manifest) !== JSON.stringify(bound) || request.artifactDigest !== bound.artifactDigest) throw new Error("QA_RUN_IDENTITY_MISMATCH");
  if (publisherTargetDigest(boundTarget) !== bound.targetDigest || request.targetLibraryPath !== boundTarget.libraryPath) throw new Error("QA_RUN_TARGET_MISMATCH");
  if (run.dispatch !== "NOT_DISPATCHED") throw new Error("QA_DISPATCH_ALREADY_CLAIMED");
  if (typeof request.headlessExecutionId !== "string" || !request.headlessExecutionId.trim()) throw new Error("QA_PUBLISH_EXECUTION_REQUIRED");
  const checked = await verifyQaPublisherSourcesWithEntries(root, bound.qaRunId, request.artifactPath);
  const expected = checked.sourceDigests;
  return runPublishStages(call, request,
    async (stage, snapshot) => {
      if (stage === "prepared") {
        const observed = snapshot?.sourceProof?.sourceMediaDigests;
        if (!Array.isArray(observed) || observed.length !== expected.length
          || !expected.every(({ source, sha256 }) => observed.some((item: { source?: unknown; sha256?: unknown }) => item.source === source && item.sha256 === sha256))) {
          throw new Error("QA_PUBLISH_SOURCE_MISMATCH");
        }
      }
      await recordQaPublisherStage(root, bound.qaRunId, stage as PublisherStage, snapshot);
    },
    async jobId => { await assertReady(jobId, Object.freeze({ ...boundTarget })); await verifyQaPublisherSourcesWithEntries(root, bound.qaRunId, request.artifactPath); await claimDispatchIntent(root, bound, jobId); },
    { stopAfterDispatch: true });
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
  let executed = false;
  const call: PublisherCall = async (name, args) => {
    if (name === "artifact.publish.preview") return { jobId, state: "awaiting-confirmation", artifactDigest: bound.artifactDigest,
      targetLibraryPath: boundTarget.libraryPath, sourceProof: { sourceMediaDigests: sources.sourceDigests } };
    if (name !== "artifact.publish.execute" || args.confirmVerification === true || executed) throw new Error("QA_SIMULATION_UNEXPECTED_CALL");
    executed = true;
    if (mode === "accepted-response-lost") throw new Error("simulated response loss after acceptance");
    return { jobId, state: "verification-pending", nextAction: "confirm-verification", delivery: { status: "dispatched" } };
  };
  return runSupervisedQaPublisherInternal(root, bound, { artifactPath, headlessExecutionId: "simulation-only",
    targetLibraryPath: boundTarget.libraryPath, artifactDigest: bound.artifactDigest }, call, async () => {
    if (mode === "intent-before-dispatch") {
      await claimDispatchIntent(root, bound, jobId);
      throw new Error("simulated interruption after durable intent");
    }
  }, boundTarget, true);
}

/** Internal verification-only seam. The injected gate and verifier are not native authorization evidence. */
export async function resumeSupervisedQaPublisherVerification(
  root: string, manifest: QaRunManifest, artifactPath: string, target: QaPublisherTarget,
  assertReady: (jobId: string, target: Readonly<QaPublisherTarget>) => Promise<void>,
  verifyJob: (jobId: string) => Promise<unknown>,
) {
  const bound = structuredClone(manifest);
  const boundTarget = structuredClone(target);
  const run = await inspectRun(root, bound.qaRunId);
  if (run.headlessProfile === "publisher-simulation-v1") throw new Error("QA_WORKER_PROFILE_MISMATCH");
  if (JSON.stringify(run.manifest) !== JSON.stringify(bound)) throw new Error("QA_RUN_IDENTITY_MISMATCH");
  if (publisherTargetDigest(boundTarget) !== bound.targetDigest) throw new Error("QA_RUN_TARGET_MISMATCH");
  const history = await readQaPublisherStages(root, bound.qaRunId);
  const jobId = run.publishJobId;
  if (run.dispatch !== "UNKNOWN_AFTER_DISPATCH" || !jobId || history.stages.length !== 2
    || history.stages[1]?.stage !== "dispatched" || history.stages[1].jobId !== jobId) throw new Error("QA_VERIFICATION_UNAVAILABLE");
  const checked = await verifyQaPublisherSourcesWithEntries(root, bound.qaRunId, artifactPath);
  await assertReady(jobId, Object.freeze({ ...boundTarget }));
  await verifyQaPublisherSourcesWithEntries(root, bound.qaRunId, artifactPath);
  if (JSON.stringify(await inspectRun(root, bound.qaRunId)) !== JSON.stringify(run)
    || JSON.stringify(await readQaPublisherStages(root, bound.qaRunId)) !== JSON.stringify(history)) throw new Error("QA_RUN_IDENTITY_MISMATCH");
  try { await publishQaRecord(join(root, bound.qaRunId, "verification-attempt.json"), `${JSON.stringify({ schemaVersion: 1, jobId })}\n`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("QA_VERIFICATION_ALREADY_CLAIMED"); throw error; }
  const verified = structuredClone(await verifyJob(jobId)) as Record<string, any>;
  const integrity = verified?.result?.sourceMediaIntegrity;
  if (verified?.jobId !== jobId || verified?.state !== "verified" || verified?.result?.verified !== true
    || integrity?.unchanged !== true || !Array.isArray(integrity.digests) || integrity.digests.length !== checked.sourceDigests.length
    || !checked.sourceDigests.every(expected => integrity.digests.some((actual: { source?: unknown; sha256?: unknown }) => actual.source === expected.source && actual.sha256 === expected.sha256))) {
    throw new Error("QA_VERIFICATION_UNCONFIRMED");
  }
  await verifyQaPublisherSourcesWithEntries(root, bound.qaRunId, artifactPath);
  const recoveryReported = Boolean(verified.recoveryReservation) || history.stages[1].recoveryReported;
  await recordQaPublisherStage(root, bound.qaRunId, recoveryReported ? "verification-recovery-required" : "verified",
    recoveryReported ? { ...verified, recoveryReservation: verified.recoveryReservation ?? { retained: true } } : verified);
  return { verdict: "BLOCKED" as const, dispatchAllowed: false as const, nativeQuiescence: "unproven" as const, scope: "publisher-response-observation" as const };
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
