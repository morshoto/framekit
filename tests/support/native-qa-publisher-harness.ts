// Test-only fault-injection harness. No production entry point imports this module.
import { join } from "node:path";
import { runPublishStages } from "./native-qa-publish-stages.mjs";
import { claimDispatchIntent, inspectRun, type QaRunManifest } from "../../scripts/native-qa/run-store.js";
import { readQaPublisherStages, recordQaPublisherStage, type PublisherStage } from "../../scripts/native-qa/publisher-stages.js";
import { verifyQaPublisherSourcesWithEntries } from "../../scripts/native-qa/publisher-source-evidence.js";
import { publishQaRecord } from "../../scripts/native-qa/atomic-record.js";
import { publisherTargetDigest, type QaPublisherTarget } from "../../scripts/native-qa/publisher-supervision.js";
type PublisherInput = Parameters<typeof runPublishStages>[1];
type PublisherCall = Parameters<typeof runPublishStages>[0];

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
