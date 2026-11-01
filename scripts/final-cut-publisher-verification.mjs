import { basename } from "node:path";
import { fileURLToPath } from "node:url";

export function verifyAcceptanceFixture(snapshot) {
  const fail = () => { throw new Error("PUBLISH_FIXTURE_MISMATCH: artifact does not contain the independently specified acceptance edit"); };
  const seconds = (time, expected) => {
    try { return BigInt(time.value) === BigInt(expected) * BigInt(time.timescale) && BigInt(time.timescale) > 0n; } catch { return false; }
  };
  const source = (clip) => {
    const path = snapshot.media?.find((item) => item.mediaId === clip.mediaId)?.source;
    if (typeof path !== "string") return "";
    try { return basename(path.startsWith("file:") ? fileURLToPath(path) : path); } catch { return ""; }
  };
  const timeline = snapshot.timeline;
  if (!timeline || !Array.isArray(timeline.clips) || !Array.isArray(timeline.storyElements)
    || timeline.frameDuration?.value !== "1" || timeline.frameDuration?.timescale !== "24") fail();
  const clips = timeline.clips.filter((clip) => clip.track === 0).sort((a, b) => a.start - b.start);
  const expected = [["clip-b.mp4", 0, 5, 8], ["clip-a.mp4", 8, 10, 12], ["clip-c.mp4", 20, 2, 10]];
  if (clips.length !== expected.length || !clips.every((clip, i) => {
    const [name, start, sourceStart, duration] = expected[i];
    return source(clip) === name && seconds(clip.startTime, start) && seconds(clip.sourceStartTime, sourceStart) && seconds(clip.durationTime, duration);
  })) fail();
  const music = timeline.clips.filter((clip) => clip.role === "music");
  if (music.length !== 1 || source(music[0]) !== "generated-music.wav" || music[0].track === 0 || music[0].gainDb !== -12
    || !seconds(music[0].startTime, 0) || !seconds(music[0].sourceStartTime, 0) || !seconds(music[0].durationTime, 30)) fail();
  const titles = timeline.storyElements.filter((element) => element.kind === "title");
  if (titles.length !== 1 || titles[0].text !== "FrameKit MVP Test" || titles[0].lane !== 1
    || !seconds(titles[0].startTime, 0) || !seconds(titles[0].durationTime, 6)) fail();
}

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

export function verifyPublishedTarget({ result, beforeLive, afterLive, expectedProject, expectedSequence, sourceSequence, targetLibraryPath }) {
  if (result.verified !== true || result.createdTarget?.projectName !== expectedProject) {
    throw new Error("FINAL_CUT_E2E_PUBLISH_VERIFICATION_FAILED: publisher did not return the requested project identity");
  }

  if (result.semanticReadback?.verified !== true
    || !result.semanticReadback.expectedDigest
    || result.semanticReadback.expectedDigest !== result.semanticReadback.observedDigest) {
    throw new Error("FINAL_CUT_E2E_PUBLISH_SEMANTIC_READBACK_FAILED: native timeline does not match the approved FCPXML");
  }
  const requiredChecks = ["timeline-duration-and-frame-rate", "clip-order-and-source-ranges", "editable-title-content-and-timing", "connected-audio-source-role-gain-and-timing", "source-media-bindings"];
  if (!requiredChecks.every((check) => result.semanticReadback.checked?.includes(check))) {
    throw new Error("PUBLISH_SEMANTIC_COVERAGE_INCOMPLETE: required semantic checks are unavailable");
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
  if (targetLibraryPath && (!result.createdTarget.libraryId || !result.createdTarget.eventId || result.createdTarget.libraryPath !== targetLibraryPath)) {
    throw new Error("PUBLISH_LIBRARY_IDENTITY_UNAVAILABLE: native library and event identities must be bound to the approved destination");
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
