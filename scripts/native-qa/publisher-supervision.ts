import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { runPublishStages } from "../final-cut-publisher-verification.mjs";
import { claimDispatchIntent, inspectRun, type QaRunManifest } from "./run-store.js";
import { recordQaPublisherStage, type PublisherStage } from "./publisher-stages.js";
import { verifyQaPublisherSourcesWithEntries } from "./publisher-source-evidence.js";

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
  const bound = structuredClone(manifest);
  const request = structuredClone(input);
  const boundTarget = structuredClone(target);
  const run = await inspectRun(root, bound.qaRunId);
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
    async jobId => { await assertReady(jobId, Object.freeze({ ...boundTarget })); await verifyQaPublisherSourcesWithEntries(root, bound.qaRunId, request.artifactPath); await claimDispatchIntent(root, bound, jobId); });
}
