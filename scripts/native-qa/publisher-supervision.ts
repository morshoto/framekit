import { runPublishStages } from "../final-cut-publisher-verification.mjs";
import { claimDispatchIntent, inspectRun, type QaRunManifest } from "./run-store.js";
import { recordQaPublisherStage, type PublisherStage } from "./publisher-stages.js";

type PublisherInput = Parameters<typeof runPublishStages>[1];
type PublisherCall = Parameters<typeof runPublishStages>[0];

/** Internal orchestration seam. The caller must supply an independently verified readiness gate. */
export async function runSupervisedQaPublisher(
  root: string, manifest: QaRunManifest, input: PublisherInput, call: PublisherCall,
  assertReady: (jobId: string) => Promise<void>,
): Promise<unknown> {
  const bound = structuredClone(manifest);
  const request = structuredClone(input);
  const run = await inspectRun(root, bound.qaRunId);
  if (JSON.stringify(run.manifest) !== JSON.stringify(bound) || request.artifactDigest !== bound.artifactDigest) throw new Error("QA_RUN_IDENTITY_MISMATCH");
  if (run.dispatch !== "NOT_DISPATCHED") throw new Error("QA_DISPATCH_ALREADY_CLAIMED");
  return runPublishStages(call, request,
    (stage, snapshot) => recordQaPublisherStage(root, bound.qaRunId, stage as PublisherStage, snapshot),
    async jobId => { await assertReady(jobId); await claimDispatchIntent(root, bound, jobId); });
}
