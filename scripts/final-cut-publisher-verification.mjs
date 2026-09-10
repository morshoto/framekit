export function verifyPublishedTarget({ result, beforeLive, afterLive, expectedProject, expectedSequence, sourceSequence }) {
  if (result.verified !== true || result.createdTarget?.projectName !== expectedProject) {
    throw new Error("FINAL_CUT_E2E_PUBLISH_VERIFICATION_FAILED: publisher did not return the requested project identity");
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
