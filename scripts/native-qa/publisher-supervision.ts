import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { runPublishStages } from "../final-cut-publisher-verification.mjs";
import { claimDispatchIntent, inspectRun, type QaRunManifest } from "./run-store.js";
import { recordQaPublisherStage, type PublisherStage } from "./publisher-stages.js";

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
  return runPublishStages(call, request,
    (stage, snapshot) => recordQaPublisherStage(root, bound.qaRunId, stage as PublisherStage, snapshot),
    async jobId => { await assertReady(jobId, Object.freeze({ ...boundTarget })); await claimDispatchIntent(root, bound, jobId); });
}
