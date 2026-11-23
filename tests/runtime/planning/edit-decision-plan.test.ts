import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptCreativeBrief, InMemorySemanticMediaIndexStore, InMemoryAnalysisArtifactStore, pinAnalysisEvidence, verifyLocalMediaSource, JsonCreativeBriefStore, type CreativeBrief, type MediaSourceIdentity } from "../../../packages/runtime/src/index.js";
import { createEditDecisionPlan, assertEditDecisionPlanCurrent } from "../../../packages/runtime/src/planning/edit-decision-plan.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "framekit-decision-"));
  const path = join(dir, "source.mov"); await writeFile(path, "source bytes");
  const source = { mediaId: "m", source: path, sourceDigest: createHash("sha256").update("source bytes").digest("hex"), mediaKind: "video" as const, duration: 10 };
  const revision = { id: "r1", sequence: 1, timestamp: "2026-01-01T00:00:00.000Z" };
  const provider = { id: "speech", provider: "fixture", version: "1", model: "model-v1", configurationDigest: "config-v1" };
  const speech = { coverageProvenance: "provider" as const, schemaVersion: 1 as const, mediaId: "m", sourceIdentity: source, revision, provider,
    requestedRange: { start: 0, end: 10 }, observedRange: { start: 0, end: 10 }, sourceTimebase: { value: "1", timescale: "1000" }, capability: "transcription-plus-vad" as const,
    words: [{ text: "Hello.", start: 1, end: 2, confidence: 0.98 }, { text: "Again", start: 4, end: 5, confidence: 0.96 }],
    vadSegments: [{ kind: "speech" as const, start: 1, end: 2 }, { kind: "speech" as const, start: 4, end: 5 }] };
  const record = { mediaId: "m", source: path, sourceIdentity: source, analysisRevision: revision, speech,
    semantic: { subjects: [], scenes: [], environments: [], timeOfDay: [], moods: [], usableRanges: [] },
    analysis: [{ capability: "speech" as const, status: "analyzed" as const, provenance: { source, analyzer: provider, ranges: [{ start: 0, end: 10 }] } }] };
  const index = new InMemorySemanticMediaIndexStore(); await index.save(record);
  const artifacts = new InMemoryAnalysisArtifactStore();
  const speechContext = { kind: "speech" as const, source, provider, revision, range: { start: 0, end: 10 } };
  const vadContext = { ...speechContext, kind: "vad" as const };
  const speechRef = await pinAnalysisEvidence(index, artifacts, speechContext, verifyLocalMediaSource);
  const vadRef = await pinAnalysisEvidence(index, artifacts, vadContext, verifyLocalMediaSource);
  const snapshot = { projectId: "p", projectName: "P", revision, media: [source], timeline: { id: "t", name: "T", duration: 10, frameDuration: { value: "1", timescale: "10" },
    clips: [{ id: "clip", mediaId: "m", name: "Interview", start: 0, duration: 10, sourceStart: 0, sourceStartTime: { value: "0", timescale: "1" }, startTime: { value: "0", timescale: "1" }, durationTime: { value: "10", timescale: "1" }, track: 1 }], storyElements: [], captions: [], markers: [] } };
  const brief: CreativeBrief = { schemaVersion: 1, id: "b", version: 1, purpose: { kind: "specified", value: "interview" }, audience: { kind: "no-preference" }, durationSeconds: { min: 5, max: 10 }, aspectRatio: "9:16", theme: "natural", visualDirection: "natural", requiredContent: [], excludedContent: [], sourceCoverage: [], speechPolicy: { kind: "specified", value: "preserve" }, musicPolicy: { kind: "specified", value: "none" }, captionPolicy: { kind: "specified", value: "basic" }, inferences: [], reviewPrompts: [] };
  const briefStore = new JsonCreativeBriefStore(join(dir, "brief.json"));
  const draft = await briefStore.create("p", brief);
  await briefStore.accept("p", draft.digest);
  const request = { snapshot, projectId: "p", timelineId: "t", revision, occurrenceId: "clip", brief, accepted: acceptCreativeBrief(brief), speechRef, vadRef, speechContext, vadContext,
    caption: { style: "basic", maxWordsPerGroup: 3, maxCharsPerLine: 20, maxLines: 2, emphasisWordIndices: [] },
    music: { occurrenceId: "music", placement: { start: 0, end: 5 }, targetLane: -1, context: { speech: "present" as const, audioEvidence: "unavailable" as const }, capabilities: { staticMusicPreview: false, ducking: false, fades: false } } };
  return { dir, path, request, artifacts, index, record, briefStore, draft };
}

test("integrates verified speech cuts, captions and explicit music omission without mutation", async () => {
  const f = await fixture();
  try {
    const before = structuredClone(f.request.snapshot);
    const result = await createEditDecisionPlan(f.request, f.artifacts, verifyLocalMediaSource, f.briefStore);
    assert.equal(result.status, "available");
    if (result.status !== "available") return;
    assert.deepEqual(f.request.snapshot, before);
    assert.equal(result.plan.reviewRequired, true);
    assert.equal(result.plan.source.sourceDigest, f.request.speechContext.source.sourceDigest);
    assert.ok(result.plan.decisions.some((item) => item.kind === "cut"));
    assert.ok(result.plan.decisions.some((item) => item.kind === "caption"));
    assert.ok(result.plan.decisions.some((item) => item.kind === "music-omission"));
    assert.ok(result.plan.decisions.filter((item) => item.kind !== "music-omission").every((item) => item.support === "unavailable"));
    assert.deepEqual(await assertEditDecisionPlanCurrent(f.request, result.plan, f.artifacts, verifyLocalMediaSource, f.briefStore), { status: "current" });
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("changes to the approved brief, target, source or evidence reject the plan", async () => {
  const f = await fixture();
  try {
    const result = await createEditDecisionPlan(f.request, f.artifacts, verifyLocalMediaSource, f.briefStore);
    assert.equal(result.status, "available"); if (result.status !== "available") return;
    const changedBrief = { ...f.request, brief: { ...f.request.brief, theme: "changed" } };
    assert.notEqual((await assertEditDecisionPlanCurrent(changedBrief, result.plan, f.artifacts, verifyLocalMediaSource, f.briefStore)).status, "current");
    const changedTarget = { ...f.request, timelineId: "other" };
    assert.notEqual((await assertEditDecisionPlanCurrent(changedTarget, result.plan, f.artifacts, verifyLocalMediaSource, f.briefStore)).status, "current");
    await f.briefStore.revise("p", f.draft.digest, { ...f.request.brief, theme: "newly revised" });
    assert.notEqual((await assertEditDecisionPlanCurrent(f.request, result.plan, f.artifacts, verifyLocalMediaSource, f.briefStore)).status, "current");
    await writeFile(f.path, "replacement");
    assert.notEqual((await assertEditDecisionPlanCurrent(f.request, result.plan, f.artifacts, verifyLocalMediaSource, f.briefStore)).status, "current");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("caption omission follows the accepted brief and ambiguous preferences remain explicit", async () => {
  const f = await fixture();
  try {
    const noCaptions = { ...f.request.brief, captionPolicy: { kind: "specified" as const, value: "none" } };
    const noCaptionStore = new JsonCreativeBriefStore(join(f.dir, "no-caption.json"));
    const noCaptionDraft = await noCaptionStore.create("p", noCaptions); await noCaptionStore.accept("p", noCaptionDraft.digest);
    const result = await createEditDecisionPlan({ ...f.request, brief: noCaptions, accepted: acceptCreativeBrief(noCaptions) }, f.artifacts, verifyLocalMediaSource, noCaptionStore);
    assert.equal(result.status, "available");
    if (result.status === "available") {
      assert.equal(result.plan.decisions.some((item) => item.kind === "caption"), false);
      assert.ok(result.plan.decisions.some((item) => item.kind === "caption-omission"));
    }
    const unspecified = { ...f.request.brief, captionPolicy: { kind: "no-preference" as const } };
    const unspecifiedStore = new JsonCreativeBriefStore(join(f.dir, "unspecified.json"));
    const unspecifiedDraft = await unspecifiedStore.create("p", unspecified); await unspecifiedStore.accept("p", unspecifiedDraft.digest);
    const uncertain = await createEditDecisionPlan({ ...f.request, brief: unspecified, accepted: acceptCreativeBrief(unspecified) }, f.artifacts, verifyLocalMediaSource, unspecifiedStore);
    assert.equal(uncertain.status, "available");
    if (uncertain.status === "available") assert.ok(uncertain.plan.decisions.some((item) => item.kind === "caption-clarification"));
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("mismatched speech and VAD artifacts cannot be combined into one plan", async () => {
  const f = await fixture();
  try {
    const changedRecord = { ...f.record, speech: { ...f.record.speech, words: [{ ...f.record.speech.words[0]!, text: "Different." }, f.record.speech.words[1]!] } };
    await f.index.save(changedRecord);
    const changed = await pinAnalysisEvidence(f.index, f.artifacts, f.request.vadContext, verifyLocalMediaSource);
    assert.notEqual(changed.artifactDigest, f.request.speechRef.artifactDigest);
    const result = await createEditDecisionPlan({ ...f.request, vadRef: changed }, f.artifacts, verifyLocalMediaSource, f.briefStore);
    assert.equal(result.status, "unavailable");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("missing optional evidence stays explicit without inventing cuts or captions", async () => {
  const f = await fixture();
  try {
    const noSpeech = { ...f.request, speechRef: undefined, speechContext: undefined, vadRef: undefined, vadContext: undefined };
    const result = await createEditDecisionPlan(noSpeech, f.artifacts, verifyLocalMediaSource, f.briefStore);
    assert.equal(result.status, "available");
    if (result.status === "available") {
      assert.ok(result.plan.decisions.some((item) => item.kind === "cut-unavailable"));
      assert.ok(result.plan.decisions.some((item) => item.kind === "caption-unavailable"));
      assert.ok(result.plan.decisions.some((item) => item.kind === "music-omission"));
      assert.equal(result.plan.decisions.some((item) => item.kind === "cut" || item.kind === "caption"), false);
    }
    const incompletePair = { ...f.request, vadContext: undefined };
    assert.equal((await createEditDecisionPlan(incompletePair, f.artifacts, verifyLocalMediaSource, f.briefStore)).status, "unavailable");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("music proposal preserves the requested source, range and gain without claiming native support", async () => {
  const f = await fixture();
  try {
    const music = { mediaId: "music", source: "music.wav", sourceDigest: "sha256:music", mediaKind: "audio" as const, duration: 10 };
    const snapshot = { ...f.request.snapshot, media: [...f.request.snapshot.media, music] };
    const musicBrief = { ...f.request.brief, musicPolicy: { kind: "specified" as const, value: "background" } };
    const request = { ...f.request, snapshot, brief: musicBrief, accepted: acceptCreativeBrief(musicBrief), music: { ...f.request.music, music, gainDb: -18, capabilities: { ...f.request.music.capabilities, staticMusicPreview: true } } };
    const musicStore = new JsonCreativeBriefStore(join(f.dir, "music.json"));
    const musicDraft = await musicStore.create("p", musicBrief); await musicStore.accept("p", musicDraft.digest);
    const result = await createEditDecisionPlan(request, f.artifacts, verifyLocalMediaSource, musicStore);
    assert.equal(result.status, "available");
    if (result.status === "available") {
      const decision = result.plan.decisions.find((item) => item.kind === "music-proposal");
      assert.equal(decision?.kind, "music-proposal");
      if (decision?.kind === "music-proposal") {
        assert.equal(decision.support, "unavailable");
        assert.equal(decision.musicPlan.placement?.sourceDigest, music.sourceDigest);
        assert.equal(decision.musicPlan.placement?.gainDb, -18);
        assert.deepEqual(decision.range, { start: 0, end: 5 });
      }
      const tampered = structuredClone(result.plan); tampered.planDigest = "sha256:tampered";
      assert.equal((await assertEditDecisionPlanCurrent(request, tampered, f.artifacts, verifyLocalMediaSource, musicStore)).status, "stale");
    }
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("unsupported nonzero frame-grid origin cannot produce a plan", async () => {
  const f = await fixture();
  try {
    const snapshot = { ...f.request.snapshot, timeline: { ...f.request.snapshot.timeline, frameGridOrigin: { value: "1", timescale: "20" } } };
    const brief = { ...f.request.brief, captionPolicy: { kind: "specified" as const, value: "none" } };
    const noCaptionStore = new JsonCreativeBriefStore(join(f.dir, "no-caption-origin.json"));
    const noCaptionDraft = await noCaptionStore.create("p", brief); await noCaptionStore.accept("p", noCaptionDraft.digest);
    const result = await createEditDecisionPlan({ ...f.request, snapshot, brief, accepted: acceptCreativeBrief(brief) }, f.artifacts, verifyLocalMediaSource, noCaptionStore);
    assert.equal(result.status, "unavailable");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("edit decision planning is exposed through the runtime package", async () => {
  const runtime = await import("../../../packages/runtime/src/index.js");
  assert.equal(typeof (runtime as Record<string, unknown>).createEditDecisionPlan, "function");
  assert.equal(typeof (runtime as Record<string, unknown>).assertEditDecisionPlanCurrent, "function");
});


test("unbound audio context is explicitly marked unverified", async () => {
  const f = await fixture();
  try {
    const request = { ...f.request, music: { ...f.request.music, context: { speech: "present" as const, audioEvidence: "available" as const } } };
    const result = await createEditDecisionPlan(request, f.artifacts, verifyLocalMediaSource, f.briefStore);
    assert.equal(result.status, "available");
    if (result.status === "available") assert.ok(result.plan.warnings.some((warning) => /audio.*unverified/i.test(warning)));
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("brief acceptance is rechecked after asynchronous evidence reads", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const reviseDuringRead = async (source: MediaSourceIdentity) => {
      await verifyLocalMediaSource(source);
      if (++calls === 2) await f.briefStore.revise("p", f.draft.digest, { ...f.request.brief, theme: "changed during planning" });
    };
    const result = await createEditDecisionPlan(f.request, f.artifacts, reviseDuringRead, f.briefStore);
    assert.equal(result.status, "unavailable");
    assert.equal((await createEditDecisionPlan(f.request, f.artifacts, verifyLocalMediaSource, undefined as never)).status, "unavailable");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("decision planning rejects stale brief coverage even for unselected sources", async () => {
  const f = await fixture();
  try {
    const extra = { mediaId: "other", source: "other.mov", sourceDigest: "b".repeat(64), mediaKind: "video" as const, duration: 10 };
    const brief = { ...f.request.brief, requiredContent: ["intro"], sourceCoverage: [{ requirement: "intro", sourceId: "other", sourceDigest: "a".repeat(64), start: 0, end: 5 }] };
    const store = new JsonCreativeBriefStore(join(f.dir, "coverage.json"));
    const draft = await store.create("p", brief); await store.accept("p", draft.digest);
    const result = await createEditDecisionPlan({ ...f.request, brief, accepted: acceptCreativeBrief(brief), snapshot: { ...f.request.snapshot, media: [...f.request.snapshot.media, extra] } }, f.artifacts, verifyLocalMediaSource, store);
    assert.equal(result.status, "unavailable");
    assert.match(result.reason, /COVERAGE/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
