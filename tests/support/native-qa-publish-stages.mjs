export async function runPublishStages(call, input, onStage, beforeDispatch = async () => {}, options = {}) {
  const boundInput = structuredClone(input);
  const { artifactDigest, ...previewInput } = boundInput;
  const preview = structuredClone(await call("artifact.publish.preview", previewInput));
  if (!preview?.jobId || preview.state !== "awaiting-confirmation"
    || preview.artifactDigest !== artifactDigest || preview.targetLibraryPath !== boundInput.targetLibraryPath) {
    throw new Error("PUBLISH_PREVIEW_MISMATCH: prepared job does not match the approved artifact and destination");
  }
  const proofDigests = preview.sourceProof?.sourceMediaDigests;
  if (boundInput.headlessExecutionId && (!Array.isArray(proofDigests) || proofDigests.length !== 4
    || new Set(proofDigests.map((item) => item.source)).size !== 4
    || !proofDigests.every((item) => typeof item.source === "string" && item.source.length > 0 && /^[a-f0-9]{64}$/.test(item.sha256 ?? "")))) {
    throw new Error("PUBLISH_SOURCE_PROOF_INCOMPLETE: the fixture requires four distinct hashed media sources");
  }
  await onStage("prepared", structuredClone(preview));
  await beforeDispatch(preview.jobId);
  const recordAfterDispatch = async (stage, snapshot, code) => {
    try { await onStage(stage, structuredClone(snapshot)); }
    catch (cause) {
      throw new Error(`${code}: job ${preview.jobId}; stage recording failed; inspect status and do not redispatch`, { cause });
    }
  };
  let dispatched;
  try {
    dispatched = structuredClone(await call("artifact.publish.execute", { jobId: preview.jobId, confirm: true }));
  } catch (cause) {
    throw new Error(`PUBLISH_DISPATCH_UNCERTAIN: job ${preview.jobId}; inspect its status and do not redispatch`, { cause });
  }
  if (dispatched?.jobId !== preview.jobId || dispatched?.state !== "verification-pending"
    || dispatched?.nextAction !== "confirm-verification" || dispatched?.delivery?.status !== "dispatched") {
    await recordAfterDispatch("dispatch-unconfirmed", dispatched, "PUBLISH_DISPATCH_UNCERTAIN");
    throw new Error(`PUBLISH_DISPATCH_INCOMPLETE: job ${preview.jobId} is ${dispatched?.state ?? "unknown"} (${dispatched?.error?.code ?? "unconfirmed"}); inspect status and do not redispatch`);
  }
  await recordAfterDispatch("dispatched", dispatched, "PUBLISH_DISPATCH_UNCERTAIN");
  if (options.stopAfterDispatch === true) return dispatched;
  let verified;
  try { verified = structuredClone(await call("artifact.publish.execute", { jobId: preview.jobId, confirm: true, confirmVerification: true })); }
  catch (cause) {
    throw new Error(`PUBLISH_VERIFICATION_INCOMPLETE: job ${preview.jobId}; inspect status and do not redispatch`, { cause });
  }
  if (verified?.jobId !== preview.jobId || verified?.state !== "verified" || verified?.result?.verified !== true) {
    throw new Error(`PUBLISH_VERIFICATION_INCOMPLETE: job ${preview.jobId} is ${verified?.state ?? "unknown"}; inspect status without redispatching`);
  }
  if (boundInput.headlessExecutionId) {
    const integrity = verified.result.sourceMediaIntegrity;
    if (integrity?.unchanged !== true || !Array.isArray(integrity.digests) || integrity.digests.length !== proofDigests.length
      || !proofDigests.every((expected) => integrity.digests.some((actual) => actual.source === expected.source && actual.sha256 === expected.sha256))) {
      throw new Error(`PUBLISH_SOURCE_INTEGRITY_MISMATCH: job ${preview.jobId} does not preserve the approved source digests; inspect status and do not redispatch`);
    }
  }
  const recoveryReservation = verified.recoveryReservation ?? dispatched.recoveryReservation;
  if (recoveryReservation) {
    await recordAfterDispatch("verification-recovery-required", { ...verified, recoveryReservation }, "PUBLISH_RECOVERY_REQUIRED");
    throw new Error(`PUBLISH_RECOVERY_REQUIRED: job ${preview.jobId} has verified readback but native quiescence is unproven; retain the reservation and do not redispatch`);
  }
  await recordAfterDispatch("verified", verified, "PUBLISH_EVIDENCE_INCOMPLETE");
  return verified;
}
