import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptCreativeBrief, type CreativeBrief } from "../../../packages/runtime/src/planning/creative-brief.js";
import { planMusic } from "../../../packages/runtime/src/planning/music-planning.js";
import { mapSpeechAnalysisToOccurrence } from "../../../packages/runtime/src/speech/mapping.js";
import type { RevisionBoundSpeechAnalysis } from "../../../packages/runtime/src/domain/media.js";

const brief: CreativeBrief = {
  schemaVersion: 1, id: "interview", version: 1, purpose: { kind: "specified", value: "interview" }, audience: { kind: "no-preference" },
  durationSeconds: { min: 30, max: 60 }, aspectRatio: "9:16", theme: "natural", visualDirection: "natural",
  requiredContent: [], excludedContent: [], sourceCoverage: [], speechPolicy: { kind: "specified", value: "preserve dialogue" },
  musicPolicy: { kind: "specified", value: "background" }, captionPolicy: { kind: "no-preference" }, inferences: [], reviewPrompts: [],
};
const revision = { id: "r1", sequence: 1, timestamp: "2026-01-01T00:00:00.000Z" };
const registeredMusic = { mediaId: "music", source: "music.wav", sourceDigest: "sha256:fixture", mediaKind: "audio" as const, duration: 40 };
const snapshot = { projectId: "p", projectName: "Project", revision, timeline: { id: "t", name: "Main", duration: 30, clips: [], storyElements: [], markers: [], captions: [] }, media: [registeredMusic] };
const fixtureVerifySource = async () => {};
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
  const claimedAudio = planMusic({ ...request, context: { speech: "absent", audioEvidence: "available" } });
  assert.ok(claimedAudio.warnings.some((warning) => /unverified/i.test(warning)));
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

test("static gain exposes its reviewable protection range without asserting audibility", () => {
  for (const speech of ["present", "absent", "unknown"] as const) {
    const plan = planMusic({ ...request, placement: { start: 5, end: 20 }, context: { speech, audioEvidence: "unavailable" } });
    assert.deepEqual(plan.dialogueProtection, {
      range: { start: 5, end: 20 },
      musicGainDb: -18,
      sourceAudio: "unchanged",
      speechContext: speech,
      speechContextVerification: "unverified",
      audibility: "unverified",
    });
  }
  const noMusic = { ...brief, musicPolicy: { kind: "specified" as const, value: "none" } };
  assert.equal(planMusic({ ...request, brief: noMusic, accepted: acceptCreativeBrief(noMusic) }).dialogueProtection, undefined);
  assert.equal(planMusic({ ...request, requestedDucking: true }).dialogueProtection, undefined);
});

test("music review maps supplied speech overlaps and exposes incomplete coverage", () => {
  const clip = { id: "dialogue", mediaId: "video", name: "Dialogue", start: 5, duration: 20, startTime: { value: "5", timescale: "1" }, durationTime: { value: "20", timescale: "1" }, sourceStart: 10, track: 1 };
  const segment = (start: number, end: number) => ({
    segment: { start: start + 5, end: end + 5, kind: "speech" as const },
    sourceRange: { start: start + 5, end: end + 5 }, sequenceRange: { start, end }, frameAlignedRange: { start, end },
  });
  const mapping = {
    occurrenceId: "dialogue", mediaId: "video", revision, sourceRange: { start: 10, end: 30 }, sequenceRange: { start: 5, end: 25 },
    sourceTimebase: { value: "1", timescale: "100" }, sequenceFrameDuration: { value: "1", timescale: "30" },
    capability: "transcription-plus-vad" as const, words: [],
    vadCoverage: [{ status: "available" as const, sourceRange: { start: 10, end: 30 }, sequenceRange: { start: 5, end: 25 }, segments: [segment(6, 9), segment(18, 23)] }],
  };
  const video = { mediaId: "video", source: "video.mov", sourceDigest: "sha256:video", mediaKind: "video" as const, duration: 30 };
  const input = { ...request, snapshot: { ...snapshot, media: [registeredMusic, video], timeline: { ...snapshot.timeline, clips: [clip] } }, placement: { start: 7, end: 20 }, speechMapping: mapping };
  const review = planMusic(input).dialogueProtection?.speechOverlap;
  assert.deepEqual(review, { occurrenceId: "dialogue", coverage: "complete", ranges: [{ start: 7, end: 9 }, { start: 18, end: 20 }], verification: "unverified" });
  const partial = { ...mapping, vadCoverage: [{ status: "unavailable" as const, sourceRange: { start: 10, end: 30 }, sequenceRange: { start: 5, end: 25 }, reason: "missing" }] };
  assert.deepEqual(planMusic({ ...input, speechMapping: partial }).dialogueProtection?.speechOverlap, { occurrenceId: "dialogue", coverage: "unknown", ranges: [], verification: "unverified" });
  assert.equal(planMusic({ ...input, placement: { start: 0, end: 20 } }).dialogueProtection?.speechOverlap?.coverage, "unknown");
  const noSpeech = { ...mapping, vadCoverage: [{ ...mapping.vadCoverage[0], segments: [] }] };
  assert.equal(planMusic({ ...input, speechMapping: noSpeech }).dialogueProtection?.speechOverlap?.coverage, "complete");
  const silence = { ...segment(10, 12), segment: { start: 15, end: 17, kind: "silence" as const } };
  assert.deepEqual(planMusic({ ...input, speechMapping: { ...mapping, vadCoverage: [{ ...mapping.vadCoverage[0], segments: [silence] }] } }).dialogueProtection?.speechOverlap?.ranges, []);
  assert.throws(() => planMusic({ ...input, speechMapping: { ...mapping, revision: { ...revision, sequence: 2 } } }), /STALE|INVALID/);
  assert.throws(() => planMusic({ ...input, speechMapping: { ...mapping, occurrenceId: "other" } }), /STALE|INVALID/);
  assert.throws(() => planMusic({ ...input, speechMapping: { ...mapping, sequenceRange: { start: 6, end: 26 } } }), /STALE|INVALID/);
  assert.throws(() => planMusic({ ...input, speechMapping: { ...mapping, vadCoverage: [...mapping.vadCoverage, ...mapping.vadCoverage] } }), /INVALID/);
  const alteredSegment = segment(6, 9); alteredSegment.sourceRange.start = 12;
  assert.throws(() => planMusic({ ...input, speechMapping: { ...mapping, vadCoverage: [{ ...mapping.vadCoverage[0], segments: [alteredSegment] }] } }), /INVALID/);
});

test("music review consumes partial coverage from the speech mapper", () => {
  const video = { mediaId: "video", source: "interview.mov", sourceDigest: "sha256:video", mediaKind: "video" as const, duration: 30 };
  const clip = { id: "dialogue", mediaId: "video", name: "Interview", start: 5, duration: 2, sourceStart: 10, track: 1,
    startTime: { value: "5", timescale: "1" }, durationTime: { value: "2", timescale: "1" } };
  const speech: RevisionBoundSpeechAnalysis = {
    schemaVersion: 1, mediaId: "video", sourceIdentity: video, requestedRange: { start: 0, end: 30 }, observedRange: { start: 0, end: 30 },
    revision, provider: { id: "fixture", provider: "fixture", version: "1" }, sourceTimebase: { value: "1", timescale: "100" },
    capability: "transcription-only", words: [], vadUnavailableReason: "partial",
    vadCoverage: [{ start: 0, end: 11, status: "available", segments: [{ start: 10.25, end: 10.35, kind: "speech" }] },
      { start: 11, end: 30, status: "unavailable", reason: "partial" }],
  };
  const mapping = mapSpeechAnalysisToOccurrence(speech, { occurrenceId: clip.id, mediaId: clip.mediaId, revision,
    sourceRange: { start: 10, end: 12 }, sequenceRange: { start: 5, end: 7, startTime: clip.startTime, durationTime: clip.durationTime } },
  { sequenceFrameDuration: { value: "1", timescale: "10" } });
  const result = planMusic({ ...request, snapshot: { ...snapshot, media: [registeredMusic, video], timeline: { ...snapshot.timeline, clips: [clip] } },
    placement: { start: 5, end: 7 }, speechMapping: mapping });
  assert.deepEqual(result.dialogueProtection?.speechOverlap, { occurrenceId: clip.id, coverage: "unknown", ranges: [{ start: 5.25, end: 5.35 }], verification: "unverified" });
});


test("source must exist in the current exact project and range", () => {
  assert.equal(planMusic({ ...request, snapshot: { ...snapshot, media: [] } }).decision, "unavailable");
  assert.equal(planMusic({ ...request, music: { ...registeredMusic, sourceDigest: "sha256:changed" } }).decision, "unavailable");
  assert.equal(planMusic({ ...request, snapshot: { ...snapshot, media: [registeredMusic, { ...registeredMusic, source: "other.wav", sourceDigest: "sha256:other" }] } }).decision, "unavailable");
  assert.equal(planMusic({ ...request, snapshot: { ...snapshot, media: [registeredMusic, registeredMusic] } }).decision, "unavailable");
  assert.throws(() => planMusic({ ...request, revision: { ...revision, sequence: 2 } }), /STALE/);
  assert.equal(planMusic({ ...request, placement: { start: 25, end: 35 } }).decision, "unsupported");
});

test("reviewed music proposal previews through the existing workflow without mutation", async (t) => {
  const { AgentVideoRuntime } = await import("../../../packages/runtime/src/runtime.js");
  const { InMemoryEditorAdapter } = await import("../../../packages/testkit/src/index.js");
  const { previewMusicPlan } = await import("../../../packages/runtime/src/planning/music-planning.js");
  const { JsonCreativeBriefStore } = await import("../../../packages/runtime/src/application/creative-brief-store.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "framekit-music-brief-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const briefStore = new JsonCreativeBriefStore(join(dir, "brief.json"));
  const draft = await briefStore.create("p", brief);
  await briefStore.accept("p", draft.digest);
  const adapter = new InMemoryEditorAdapter({ projectId: "p", projectName: "Project", timelineId: "t", timelineName: "Main", clips: [{ id: "dialogue", name: "Dialogue", start: 0, duration: 30, track: 1 }], media: [registeredMusic] });
  const runtime = new AgentVideoRuntime(adapter);
  const before = await runtime.inspectProject();
  const liveRequest = { ...request, snapshot: before, revision: before.revision };
  const plan = planMusic(liveRequest);
  const preview = await previewMusicPlan(runtime, liveRequest, plan, "music-clip", fixtureVerifySource, briefStore);
  assert.equal("previewToken" in preview, false, "review-only output must not expose an executable editor token");
  assert.deepEqual(await runtime.inspectProject(), before);
  assert.equal(preview.operations.some((operation) => operation.type === "timeline.media.add" && operation.mediaId === "music"), true);
  assert.equal(preview.operations.some((operation) => operation.type === "set-gain" && operation.gainDb === -18), true);
  await assert.rejects(() => previewMusicPlan(runtime, { ...liveRequest, context: { ...liveRequest.context, speech: "absent" } }, plan, "music-clip", fixtureVerifySource, briefStore), /STALE/);
  const changedSnapshot = { ...before, timeline: { ...before.timeline, duration: before.timeline.duration + 1 } };
  const changedRuntime = { inspectProject: async () => changedSnapshot, previewMusic: runtime.previewMusic.bind(runtime) };
  await assert.rejects(() => previewMusicPlan(changedRuntime, liveRequest, plan, "music-clip", fixtureVerifySource, briefStore), /STALE/);
  await assert.rejects(() => previewMusicPlan(runtime, liveRequest, plan, "different-clip", fixtureVerifySource, briefStore), /STALE|INVALID/);
  await assert.rejects(() => previewMusicPlan(runtime, liveRequest, plan, "music-clip", undefined as never, briefStore), /UNAVAILABLE|INVALID/);
  await assert.rejects(() => previewMusicPlan(runtime, liveRequest, plan, "music-clip", async () => { throw new Error("source changed"); }, briefStore), /source changed/);
  await assert.rejects(() => previewMusicPlan(runtime, liveRequest, plan, "music-clip", fixtureVerifySource, undefined as never), /UNAVAILABLE|INVALID/);
  const altered = { ...plan, placement: { ...plan.placement!, gainDb: -3 } };
  await assert.rejects(() => previewMusicPlan(runtime, liveRequest, altered, "music-clip", fixtureVerifySource, briefStore), /STALE|INVALID/);
  const mutable = structuredClone(altered);
  const mutatingStore = Object.create(briefStore) as typeof briefStore;
  mutatingStore.read = async (projectId) => {
    const value = await briefStore.read(projectId);
    mutable.placement!.gainDb = plan.placement!.gainDb;
    return value;
  };
  await assert.rejects(() => previewMusicPlan(runtime, liveRequest, mutable, "music-clip", fixtureVerifySource, mutatingStore), /STALE|INVALID/);
  await assert.rejects(() => previewMusicPlan(runtime, { ...liveRequest, revision: { ...before.revision, sequence: before.revision.sequence + 1 } }, plan, "music-clip", fixtureVerifySource, briefStore), /STALE/);
  let inspections = 0;
  const projectRace = { inspectProject: async () => ++inspections === 1 ? before : { ...before, revision: { ...before.revision, sequence: before.revision.sequence + 1 } },
    previewMusic: runtime.previewMusic.bind(runtime) };
  await assert.rejects(() => previewMusicPlan(projectRace, liveRequest, plan, "music-clip", fixtureVerifySource, briefStore), /STALE/);
  let sourceInspections = 0;
  const sourceRace = { inspectProject: async () => ++sourceInspections === 1 ? before : { ...before,
    media: before.media.map((source) => source.mediaId === "music" ? { ...source, sourceDigest: "changed" } : source) },
    previewMusic: runtime.previewMusic.bind(runtime) };
  await assert.rejects(() => previewMusicPlan(sourceRace, liveRequest, plan, "music-clip", fixtureVerifySource, briefStore), /STALE/);
  const wrongPreview = { inspectProject: runtime.inspectProject.bind(runtime), previewMusic: async () => ({ ...preview, previewToken: "fixture-token",
    target: { kind: "editor.timeline" as const, projectId: "other", sequenceId: "other" } }) };
  await assert.rejects(() => previewMusicPlan(wrongPreview, liveRequest, plan, "music-clip", fixtureVerifySource, briefStore), /STALE|TARGET/);
  const wrongOperations = { inspectProject: runtime.inspectProject.bind(runtime), previewMusic: async () => ({ ...preview, previewToken: "fixture-token",
    operations: preview.operations.map((operation) => operation.type === "set-gain" ? { ...operation, gainDb: -3 } : operation) }) };
  await assert.rejects(() => previewMusicPlan(wrongOperations, liveRequest, plan, "music-clip", fixtureVerifySource, briefStore), /STALE|MISMATCH/);
  const wrongBase = { inspectProject: runtime.inspectProject.bind(runtime), previewMusic: async () => ({ ...preview, previewToken: "fixture-token",
    baseRevision: { ...preview.baseRevision, sequence: preview.baseRevision.sequence + 1 } }) };
  await assert.rejects(() => previewMusicPlan(wrongBase, liveRequest, plan, "music-clip", fixtureVerifySource, briefStore), /STALE/);
  const racingRuntime = {
    inspectProject: runtime.inspectProject.bind(runtime),
    previewMusic: async (input: Parameters<typeof runtime.previewMusic>[0]) => {
      const result = await runtime.previewMusic(input);
      await briefStore.revise("p", draft.digest, { ...brief, theme: "revised" });
      return result;
    },
  };
  await assert.rejects(() => previewMusicPlan(racingRuntime, liveRequest, plan, "music-clip", fixtureVerifySource, briefStore), /STALE|NOT_ACCEPTED/);
  assert.deepEqual(await runtime.inspectProject(), before);
  await assert.rejects(() => previewMusicPlan(runtime, liveRequest, plan, "music-clip", fixtureVerifySource, briefStore), /STALE|NOT_ACCEPTED/);
});

test("invalid timeline duration and contradictory exact timing cannot produce a proposal", () => {
  assert.equal(planMusic({ ...request, snapshot: { ...snapshot, timeline: { ...snapshot.timeline, duration: Number.NaN } } }).decision, "unsupported");
  const contradictory = { start: 0, end: 30, startTime: { value: "2", timescale: "1" }, durationTime: { value: "30", timescale: "1" } };
  assert.equal(planMusic({ ...request, placement: contradictory }).decision, "unsupported");
});

test("music planning is exposed through the runtime package", async () => {
  const runtime = await import("../../../packages/runtime/src/index.js");
  assert.equal(typeof (runtime as Record<string, unknown>).planMusic, "function");
  assert.equal(typeof (runtime as Record<string, unknown>).previewMusicPlan, "function");
});

test("music preview rejects changed sources bound to accepted brief coverage", async (t) => {
  const { AgentVideoRuntime } = await import("../../../packages/runtime/src/runtime.js");
  const { InMemoryEditorAdapter } = await import("../../../packages/testkit/src/index.js");
  const { previewMusicPlan } = await import("../../../packages/runtime/src/planning/music-planning.js");
  const { JsonCreativeBriefStore } = await import("../../../packages/runtime/src/application/creative-brief-store.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "framekit-music-coverage-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const covered = { mediaId: "video", source: "video.mov", sourceDigest: "a".repeat(64), mediaKind: "video" as const, duration: 20 };
  const boundBrief = { ...brief, requiredContent: ["intro"], sourceCoverage: [{ requirement: "intro", sourceId: "video", sourceDigest: covered.sourceDigest, start: 0, end: 10 }] };
  const store = new JsonCreativeBriefStore(join(dir, "brief.json"));
  const draft = await store.create("p", boundBrief); await store.accept("p", draft.digest);
  const adapter = new InMemoryEditorAdapter({ projectId: "p", projectName: "Project", timelineId: "t", timelineName: "Main", clips: [{ id: "dialogue", name: "Dialogue", start: 0, duration: 30, track: 1 }], media: [registeredMusic, covered] });
  const runtime = new AgentVideoRuntime(adapter); const current = await runtime.inspectProject();
  const input = { ...request, brief: boundBrief, accepted: acceptCreativeBrief(boundBrief), snapshot: current, revision: current.revision };
  const plan = planMusic(input);
  const changed = { ...current, media: current.media.map((media) => media.mediaId === "video" ? { ...media, sourceDigest: "b".repeat(64) } : media) };
  const changedRuntime = { inspectProject: async () => changed, previewMusic: runtime.previewMusic.bind(runtime) };
  await assert.rejects(() => previewMusicPlan(changedRuntime, input, plan, "music-clip", fixtureVerifySource, store), /COVERAGE/);
});

test("music preview verifies every brief-covered source before and after preview", async (t) => {
  const { AgentVideoRuntime } = await import("../../../packages/runtime/src/runtime.js");
  const { InMemoryEditorAdapter } = await import("../../../packages/testkit/src/index.js");
  const { previewMusicPlan } = await import("../../../packages/runtime/src/planning/music-planning.js");
  const { JsonCreativeBriefStore } = await import("../../../packages/runtime/src/application/creative-brief-store.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "framekit-music-verify-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const covered = { mediaId: "video", source: "video.mov", sourceDigest: "a".repeat(64), mediaKind: "video" as const, duration: 20 };
  const boundBrief = { ...brief, requiredContent: ["intro"], sourceCoverage: [{ requirement: "intro", sourceId: "video", sourceDigest: covered.sourceDigest, start: 0, end: 10 }] };
  const store = new JsonCreativeBriefStore(join(dir, "brief.json"));
  const draft = await store.create("p", boundBrief); await store.accept("p", draft.digest);
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({ projectId: "p", projectName: "Project", timelineId: "t", timelineName: "Main", clips: [{ id: "dialogue", name: "Dialogue", start: 0, duration: 30, track: 1 }], media: [registeredMusic, covered] }));
  const current = await runtime.inspectProject();
  const input = { ...request, brief: boundBrief, accepted: acceptCreativeBrief(boundBrief), snapshot: current, revision: current.revision };
  const plan = planMusic(input); let coverageChecks = 0;
  await assert.rejects(() => previewMusicPlan(runtime, input, plan, "music-clip", async (source) => {
    if (source.mediaId === "video" && ++coverageChecks === 2) throw new Error("covered source changed");
  }, store), /covered source changed/);
  assert.equal(coverageChecks, 2);
});

test("music preview verifies the mapped speech source before and after preview", async (t) => {
  const { AgentVideoRuntime } = await import("../../../packages/runtime/src/runtime.js");
  const { InMemoryEditorAdapter } = await import("../../../packages/testkit/src/index.js");
  const { previewMusicPlan } = await import("../../../packages/runtime/src/planning/music-planning.js");
  const { JsonCreativeBriefStore } = await import("../../../packages/runtime/src/application/creative-brief-store.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "framekit-music-speech-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const video = { mediaId: "video", source: "video.mov", sourceDigest: "sha256:video", mediaKind: "video" as const, duration: 30 };
  const store = new JsonCreativeBriefStore(join(dir, "brief.json"));
  const draft = await store.create("p", brief); await store.accept("p", draft.digest);
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({ projectId: "p", projectName: "Project", timelineId: "t", timelineName: "Main",
    clips: [{ id: "dialogue", mediaId: "video", name: "Dialogue", start: 0, duration: 30, track: 1 }], media: [registeredMusic, video] }));
  const current = await runtime.inspectProject();
  const speechMapping = { occurrenceId: "dialogue", mediaId: "video", revision: current.revision, sourceRange: { start: 0, end: 30 }, sequenceRange: { start: 0, end: 30 },
    sourceTimebase: { value: "1", timescale: "100" }, sequenceFrameDuration: { value: "1", timescale: "30" }, capability: "transcription-only" as const, words: [] };
  const input = { ...request, snapshot: current, revision: current.revision, speechMapping };
  const plan = planMusic(input); let speechChecks = 0;
  await assert.rejects(() => previewMusicPlan(runtime, input, plan, "music-clip", async (source) => {
    if (source.mediaId === "video") throw new Error("speech source unavailable");
  }, store), /speech source unavailable/);
  await assert.rejects(() => previewMusicPlan(runtime, input, plan, "music-clip", async (source) => {
    if (source.mediaId === "video" && ++speechChecks === 2) throw new Error("speech source changed");
  }, store), /speech source changed/);
  assert.equal(speechChecks, 2);
  assert.throws(() => planMusic({ ...input, snapshot: { ...current, media: current.media.map((source) => source.mediaId === "video" ? { ...source, sourceDigest: undefined } : source) } }), /INVALID_MUSIC_PLAN/);
});
