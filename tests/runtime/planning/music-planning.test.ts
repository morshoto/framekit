import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptCreativeBrief, type CreativeBrief } from "../../../packages/runtime/src/planning/creative-brief.js";
import { planMusic } from "../../../packages/runtime/src/planning/music-planning.js";

const brief: CreativeBrief = {
  schemaVersion: 1, id: "interview", version: 1, purpose: { kind: "specified", value: "interview" }, audience: { kind: "no-preference" },
  durationSeconds: { min: 30, max: 60 }, aspectRatio: "9:16", theme: "natural", visualDirection: "natural",
  requiredContent: [], excludedContent: [], sourceCoverage: [], speechPolicy: { kind: "specified", value: "preserve dialogue" },
  musicPolicy: { kind: "specified", value: "background" }, captionPolicy: { kind: "no-preference" }, inferences: [], reviewPrompts: [],
};
const revision = { id: "r1", sequence: 1, timestamp: "2026-01-01T00:00:00.000Z" };
const registeredMusic = { mediaId: "music", source: "music.wav", sourceDigest: "sha256:fixture", mediaKind: "audio" as const, duration: 40 };
const snapshot = { projectId: "p", projectName: "Project", revision, timeline: { id: "t", name: "Main", duration: 30, clips: [], storyElements: [], markers: [], captions: [] }, media: [registeredMusic] };
const request = {
  snapshot, occurrenceId: "music-clip",
  brief, accepted: acceptCreativeBrief(brief), projectId: "p", timelineId: "t", revision,
  music: registeredMusic,
  placement: { start: 0, end: 30 }, gainDb: -18, targetLane: -1,
  context: { speech: "present" as const, audioEvidence: "unavailable" as const },
  capabilities: { staticMusicPreview: true, ducking: false, fades: false },
};

test("produces a reviewable registered-music proposal without claiming audibility", () => {
  const before = structuredClone(request);
  const plan = planMusic(request);
  assert.deepEqual(request, before);
  assert.equal(plan.decision, "propose-music");
  assert.equal(plan.reviewRequired, true);
  assert.equal(plan.placement?.mediaId, "music");
  assert.deepEqual(plan.placement?.range, request.placement);
  assert.equal(plan.placement?.gainDb, -18);
  assert.equal(plan.dialogueVerificationRequired, true);
  assert.ok(plan.warnings.some((warning) => /unavailable/i.test(warning)));
  assert.ok(plan.reason);
});

test("explicit no music is honored and preference ambiguity is exposed", () => {
  const silentBrief = { ...brief, musicPolicy: { kind: "specified" as const, value: "none" } };
  const omitted = planMusic({ ...request, brief: silentBrief, accepted: acceptCreativeBrief(silentBrief) });
  assert.equal(omitted.decision, "omit-music");
  assert.equal(omitted.placement, undefined);
  const unspecified = { ...brief, musicPolicy: { kind: "no-preference" as const } };
  assert.equal(planMusic({ ...request, brief: unspecified, accepted: acceptCreativeBrief(unspecified) }).decision, "needs-review");
});

test("rejects changed briefs and reports unavailable or unsupported decisions", () => {
  assert.throws(() => planMusic({ ...request, brief: { ...brief, theme: "changed" } }), /STALE_BRIEF/);
  assert.equal(planMusic({ ...request, music: undefined }).decision, "unavailable");
  assert.equal(planMusic({ ...request, capabilities: { ...request.capabilities, staticMusicPreview: false } }).decision, "unsupported");
  assert.equal(planMusic({ ...request, requestedDucking: true }).decision, "unsupported");
  assert.equal(planMusic({ ...request, gainDb: undefined }).decision, "needs-review");
});

test("does not infer an audible mix from gameplay, music-led, or missing analysis", () => {
  for (const context of [{ speech: "present" as const, audioEvidence: "unavailable" as const }, { speech: "absent" as const, audioEvidence: "available" as const }, { speech: "unknown" as const, audioEvidence: "unavailable" as const }]) {
    const plan = planMusic({ ...request, context });
    assert.equal(plan.reviewRequired, true);
    assert.equal(plan.dialogueVerificationRequired, true);
    assert.ok(plan.warnings.some((warning) => /verif|audib/i.test(warning)));
  }
});


test("source must exist in the current exact project and range", () => {
  assert.equal(planMusic({ ...request, snapshot: { ...snapshot, media: [] } }).decision, "unavailable");
  assert.equal(planMusic({ ...request, music: { ...registeredMusic, sourceDigest: "sha256:changed" } }).decision, "unavailable");
  assert.throws(() => planMusic({ ...request, revision: { ...revision, sequence: 2 } }), /STALE/);
  assert.equal(planMusic({ ...request, placement: { start: 25, end: 35 } }).decision, "unsupported");
});

test("reviewed music proposal previews through the existing workflow without mutation", async () => {
  const { AgentVideoRuntime } = await import("../../../packages/runtime/src/runtime.js");
  const { InMemoryEditorAdapter } = await import("../../../packages/testkit/src/index.js");
  const { previewMusicPlan } = await import("../../../packages/runtime/src/planning/music-planning.js");
  const adapter = new InMemoryEditorAdapter({ projectId: "p", projectName: "Project", timelineId: "t", timelineName: "Main", clips: [{ id: "dialogue", name: "Dialogue", start: 0, duration: 30, track: 1 }], media: [registeredMusic] });
  const runtime = new AgentVideoRuntime(adapter);
  const before = await runtime.inspectProject();
  const liveRequest = { ...request, snapshot: before, revision: before.revision };
  const plan = planMusic(liveRequest);
  const preview = await previewMusicPlan(runtime, liveRequest, plan, "music-clip");
  assert.deepEqual(await runtime.inspectProject(), before);
  assert.equal(preview.operations.some((operation) => operation.type === "timeline.media.add" && operation.mediaId === "music"), true);
  assert.equal(preview.operations.some((operation) => operation.type === "set-gain" && operation.gainDb === -18), true);
  await assert.rejects(() => previewMusicPlan(runtime, { ...liveRequest, context: { ...liveRequest.context, speech: "absent" } }, plan, "music-clip"), /STALE/);
  const changedSnapshot = { ...before, timeline: { ...before.timeline, duration: before.timeline.duration + 1 } };
  const changedRuntime = { inspectProject: async () => changedSnapshot, previewMusic: runtime.previewMusic.bind(runtime) };
  await assert.rejects(() => previewMusicPlan(changedRuntime, liveRequest, plan, "music-clip"), /STALE/);
  await assert.rejects(() => previewMusicPlan(runtime, liveRequest, plan, "different-clip"), /STALE|INVALID/);
  const altered = { ...plan, placement: { ...plan.placement!, gainDb: -3 } };
  await assert.rejects(() => previewMusicPlan(runtime, liveRequest, altered, "music-clip"), /STALE|INVALID/);
  await assert.rejects(() => previewMusicPlan(runtime, { ...liveRequest, revision: { ...before.revision, sequence: before.revision.sequence + 1 } }, plan, "music-clip"), /STALE/);
});
