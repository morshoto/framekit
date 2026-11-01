export async function runPublishStages(call, input, onStage) {
  const { artifactDigest, ...previewInput } = input;
  const preview = await call("artifact.publish.preview", previewInput);
  if (!preview.jobId || preview.state !== "awaiting-confirmation"
    || preview.artifactDigest !== artifactDigest || preview.targetLibraryPath !== input.targetLibraryPath) {
    throw new Error("PUBLISH_PREVIEW_MISMATCH: prepared job does not match the approved artifact and destination");
  }
  onStage("prepared", preview);
  let dispatched;
  try {
    dispatched = await call("artifact.publish.execute", { jobId: preview.jobId, confirm: true });
  } catch (cause) {
    throw new Error(`PUBLISH_DISPATCH_UNCERTAIN: job ${preview.jobId}; inspect its status and do not redispatch`, { cause });
  }
  onStage("dispatched", dispatched);
  if (dispatched.jobId !== preview.jobId || dispatched.state !== "verification-pending") {
    throw new Error(`PUBLISH_DISPATCH_INCOMPLETE: job ${preview.jobId} is ${dispatched.state}; inspect status and do not redispatch`);
  }
  const verified = await call("artifact.publish.execute", { jobId: preview.jobId, confirm: true, confirmVerification: true });
  if (verified.jobId !== preview.jobId || verified.state !== "verified" || verified.result?.verified !== true) {
    throw new Error(`PUBLISH_VERIFICATION_INCOMPLETE: job ${preview.jobId} is ${verified.state}; inspect status without redispatching`);
  }
  onStage("verified", verified);
  return verified;
}

export function verifyPublishedTarget({ result, beforeLive, afterLive, expectedProject, expectedSequence, sourceSequence }) {
  if (result.verified !== true || result.createdTarget?.projectName !== expectedProject) {
    throw new Error("FINAL_CUT_E2E_PUBLISH_VERIFICATION_FAILED: publisher did not return the requested project identity");
  }

  if (result.semanticReadback?.verified !== true
    || !result.semanticReadback.expectedDigest
    || result.semanticReadback.expectedDigest !== result.semanticReadback.observedDigest) {
    throw new Error("FINAL_CUT_E2E_PUBLISH_SEMANTIC_READBACK_FAILED: native timeline does not match the approved FCPXML");
  }
  if (result.sourceMediaIntegrity?.unchanged !== true) {
    throw new Error("FINAL_CUT_E2E_PUBLISH_SOURCE_MEDIA_FAILED: source-media digests were not preserved");
  }

  if (result.createdTarget?.sequenceName !== (expectedSequence ?? sourceSequence)) {
    throw new Error("FINAL_CUT_E2E_PUBLISH_SEQUENCE_VERIFICATION_FAILED: publisher did not return the requested sequence identity");
  }

  const projectId = result.createdTarget?.projectId;
  const sequenceId = result.createdTarget?.sequenceId;
  const activeProjectAfterId = result.activeProject?.after?.id;
  if (!projectId || !sequenceId || !activeProjectAfterId) {
    throw new Error("FINAL_CUT_E2E_PUBLISH_TARGET_VERIFICATION_FAILED: publisher did not return imported target identities");
  }
  if (result.activeProject?.before?.id !== beforeLive.project.id || activeProjectAfterId !== projectId) {
    throw new Error("FINAL_CUT_E2E_PUBLISH_TARGET_VERIFICATION_FAILED: active project identity was not changed to the imported project");
  }

  if (!afterLive.project?.id || !afterLive.sequence?.id) {
    throw new Error("FINAL_CUT_E2E_PUBLISH_LIVE_STATE_MISMATCH: live state did not return imported target identities");
  }
  if (afterLive.project.id !== projectId || afterLive.sequence.id !== sequenceId) {
    throw new Error("FINAL_CUT_E2E_PUBLISH_LIVE_STATE_MISMATCH: live state does not match the imported target");
  }
}
