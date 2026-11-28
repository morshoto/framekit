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
  const briefStore = new JsonCreativeBriefStore(join(dir, "brief.json"), async (_binding, operation) => operation({} as import("@framekit/runtime").ProjectStore));
  const draft = await briefStore.create("p", brief);
  await briefStore.accept("p", draft.digest, (publish) => publish(), { sequenceId: "t", revision, timelineDigest: "a".repeat(64) });
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

test("music overlap is derived from pinned VAD instead of caller speech context", async () => {
  const f = await fixture();
  try {
    const music = { mediaId: "music", source: "music.wav", sourceDigest: "sha256:music", mediaKind: "audio" as const, duration: 10 };
    const brief = { ...f.request.brief, musicPolicy: { kind: "specified" as const, value: "background" } };
    const store = new JsonCreativeBriefStore(join(f.dir, "music-brief.json"));
    const draft = await store.create("p", brief); await store.accept("p", draft.digest);
    const request = { ...f.request, brief, accepted: acceptCreativeBrief(brief), snapshot: { ...f.request.snapshot, media: [...f.request.snapshot.media, music] },
      music: { ...f.request.music, music, gainDb: -18, context: { speech: "absent" as const, audioEvidence: "unavailable" as const },
        speechMapping: { occurrenceId: "other", mediaId: "m", revision: f.request.revision, sourceRange: { start: 0, end: 10 }, sequenceRange: { start: 0, end: 10 },
          sourceTimebase: { value: "1", timescale: "1000" }, sequenceFrameDuration: { value: "1", timescale: "10" }, capability: "transcription-only" as const, words: [] },
        capabilities: { ...f.request.music.capabilities, staticMusicPreview: true } } };
    const result = await createEditDecisionPlan(request, f.artifacts, verifyLocalMediaSource, store);
    assert.equal(result.status, "available");
    if (result.status !== "available") return;
    const musicDecision = result.plan.decisions.find((decision) => decision.kind === "music-proposal");
    assert.equal(musicDecision?.kind, "music-proposal");
    if (musicDecision?.kind !== "music-proposal") return;
    assert.deepEqual(musicDecision.vadRef, request.vadRef);
    assert.deepEqual(musicDecision.musicPlan.dialogueProtection?.speechOverlap, {
      occurrenceId: "clip", coverage: "complete", ranges: [{ start: 1, end: 2 }, { start: 4, end: 5 }], verification: "unverified",
    });
    assert.ok(result.plan.warnings.some((warning) => /pinned.*vad/i.test(warning)));
    const altered = structuredClone(result.plan);
    const alteredMusic = altered.decisions.find((decision) => decision.kind === "music-proposal");
    if (alteredMusic?.kind !== "music-proposal") throw new Error("missing music proposal");
    alteredMusic.musicPlan.dialogueProtection!.speechOverlap!.ranges[0]!.start = 1.5;
    assert.equal((await assertEditDecisionPlanCurrent(request, altered, f.artifacts, verifyLocalMediaSource, store)).status, "stale");
    await writeFile(f.path, "changed speech source");
    assert.equal((await assertEditDecisionPlanCurrent(request, result.plan, f.artifacts, verifyLocalMediaSource, store)).status, "stale");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("planning binds the request before asynchronous brief reads", async () => {
  const f = await fixture();
  try {
    const expected = await createEditDecisionPlan(f.request, f.artifacts, verifyLocalMediaSource, f.briefStore);
    assert.equal(expected.status, "available");
    const request = structuredClone(f.request);
    const store = Object.create(f.briefStore) as typeof f.briefStore;
    store.read = async (projectId) => {
      const result = await f.briefStore.read(projectId);
      request.caption.maxWordsPerGroup = 1;
      return result;
    };
    assert.deepEqual(await createEditDecisionPlan(request, f.artifacts, verifyLocalMediaSource, store), expected);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("plan validation cannot be changed from stale to current during verification", async () => {
  const f = await fixture();
  try {
    const result = await createEditDecisionPlan(f.request, f.artifacts, verifyLocalMediaSource, f.briefStore);
    assert.equal(result.status, "available");
    if (result.status !== "available") return;
    const stale = structuredClone(result.plan);
    stale.planDigest = "sha256:stale";
    const checked = await assertEditDecisionPlanCurrent(f.request, stale, f.artifacts, async (source) => {
      stale.planDigest = result.plan.planDigest;
      await verifyLocalMediaSource(source);
    }, f.briefStore);
    assert.equal(checked.status, "stale");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("integrated plans explain withheld speech candidates", async () => {
  const f = await fixture();
  try {
    const speech = { ...f.record.speech, words: [f.record.speech.words[0]!, { ...f.record.speech.words[1]!, confidence: 0.71 }] };
    await f.index.save({ ...f.record, speech });
    const speechRef = await pinAnalysisEvidence(f.index, f.artifacts, f.request.speechContext, verifyLocalMediaSource);
    const vadRef = await pinAnalysisEvidence(f.index, f.artifacts, f.request.vadContext, verifyLocalMediaSource);
    const result = await createEditDecisionPlan({ ...f.request, speechRef, vadRef }, f.artifacts, verifyLocalMediaSource, f.briefStore);
    assert.equal(result.status, "available");
    if (result.status !== "available") return;
    assert.equal(result.plan.decisions.some((decision) => decision.kind === "cut"), false);
    assert.ok(result.plan.warnings.some((warning) => /confidence.*review/i.test(warning)));
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

test("decision planning verifies bytes of every brief-covered source", async () => {
  const f = await fixture();
  try {
    const path = join(f.dir, "other.mov"); await writeFile(path, "original");
    const extra = { mediaId: "other", source: path, sourceDigest: createHash("sha256").update("original").digest("hex"), mediaKind: "video" as const, duration: 10 };
    const brief = { ...f.request.brief, requiredContent: ["intro"], sourceCoverage: [{ requirement: "intro", sourceId: "other", sourceDigest: extra.sourceDigest, start: 0, end: 5 }] };
    const store = new JsonCreativeBriefStore(join(f.dir, "coverage-bytes.json"));
    const draft = await store.create("p", brief); await store.accept("p", draft.digest);
    const input = { ...f.request, brief, accepted: acceptCreativeBrief(brief), snapshot: { ...f.request.snapshot, media: [...f.request.snapshot.media, extra] } };
    assert.equal((await createEditDecisionPlan(input, f.artifacts, verifyLocalMediaSource, store)).status, "available");
    let checks = 0;
    const changeBetweenChecks = async (source: MediaSourceIdentity) => {
      if (source.mediaId === "other" && ++checks === 2) await writeFile(path, "changed");
      await verifyLocalMediaSource(source);
    };
    assert.equal((await createEditDecisionPlan(input, f.artifacts, changeBetweenChecks, store)).status, "unavailable");
    assert.equal(checks, 2);
    await writeFile(path, "changed");
    assert.equal((await createEditDecisionPlan(input, f.artifacts, verifyLocalMediaSource, store)).status, "unavailable");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("music decisions retain verified source audio evidence and reject changed artifacts", async () => {
  const f = await fixture();
  try {
    const source = f.request.snapshot.media[0]!;
    const revision = f.request.revision;
    const provider = { id: "audio", provider: "fixture", version: "1", configurationDigest: "audio-config" };
    const range = { start: 0, end: 10 };
    const context = { kind: "audio" as const, source, provider, revision, range };
    const index = new InMemorySemanticMediaIndexStore();
    await index.save({ mediaId: source.mediaId, source: source.source, sourceIdentity: source, analysisRevision: revision,
      semantic: { subjects: [], scenes: [], environments: [], timeOfDay: [], moods: [], usableRanges: [] },
      analysis: [{ capability: "audio", status: "analyzed", provenance: { source, analyzer: provider, ranges: [range] } }],
      audio: { coverageProvenance: "provider", mediaId: source.mediaId, sourceIdentity: source, revision, provider, requestedRange: range, measuredRange: range, integratedLufs: -20, truePeakDb: -2, silenceMs: 10, valid: true } });
    const audioRef = await pinAnalysisEvidence(index, f.artifacts, context, verifyLocalMediaSource);
    const input = { ...f.request, audioRef, audioContext: context, music: { ...f.request.music, context: { speech: "present" as const, audioEvidence: "available" as const } } };
    const result = await createEditDecisionPlan(input, f.artifacts, verifyLocalMediaSource, f.briefStore);
    assert.equal(result.status, "available");
    if (result.status !== "available") return;
    const music = result.plan.decisions.find((decision) => decision.kind === "music-omission");
    assert.deepEqual(music && "audioRef" in music ? music.audioRef : undefined, audioRef);
    assert.ok(result.plan.warnings.some((warning) => /mix|audib/i.test(warning)));
    const missing = new InMemoryAnalysisArtifactStore();
    assert.equal((await createEditDecisionPlan(input, missing, verifyLocalMediaSource, f.briefStore)).status, "unavailable");
    let reads = 0;
    const changingArtifacts = { put: f.artifacts.put.bind(f.artifacts), get: async (digest: string) => {
      if (digest === audioRef.artifactDigest && ++reads === 2) return Buffer.from("tampered");
      return f.artifacts.get(digest);
    } };
    assert.equal((await createEditDecisionPlan(input, changingArtifacts, verifyLocalMediaSource, f.briefStore)).status, "unavailable");
    assert.equal(reads, 2);
    const partial = { ...input, audioContext: { ...context, range: { start: 1, end: 9 } } };
    assert.equal((await createEditDecisionPlan(partial, f.artifacts, verifyLocalMediaSource, f.briefStore)).status, "unavailable");
    const wrongRevision = { ...input, audioContext: { ...context, revision: { ...revision, sequence: 2 } } };
    assert.equal((await createEditDecisionPlan(wrongRevision, f.artifacts, verifyLocalMediaSource, f.briefStore)).status, "unavailable");
    const missingPair = { ...input, audioContext: undefined };
    assert.equal((await createEditDecisionPlan(missingPair, f.artifacts, verifyLocalMediaSource, f.briefStore)).status, "unavailable");
    const { HeadlessDecisionPlanService } = await import("../../../apps/mcp-server/src/headless-decision-plan.js");
    const { snapshot: _snapshot, brief: _brief, accepted: _accepted, speechContext: _speechContext,
      vadContext: _vadContext, audioContext: _audioContext, speechRef: _speechRef, vadRef: _vadRef, ...audioInput } = input;
    const common = { readProject: async () => structuredClone(f.request.snapshot), storeForProject: () => f.briefStore,
      index, verifySource: verifyLocalMediaSource, currentProvider: () => provider };
    const planned = await new HeadlessDecisionPlanService({ ...common, artifacts: f.artifacts }).plan(audioInput);
    assert.equal(planned.status, "available"); if (planned.status !== "available") return;
    let audioReads = 0;
    const racing = { put: f.artifacts.put.bind(f.artifacts), get: async (digest: string) => {
      const bytes = await f.artifacts.get(digest);
      if (digest === audioRef.artifactDigest && ++audioReads === 2) {
        const record = await index.load(source);
        await index.save({ ...record!, audio: { ...record!.audio!, integratedLufs: -10 } });
      }
      return bytes;
    } };
    const service = new HeadlessDecisionPlanService({ ...common, artifacts: racing });
    await assert.rejects(service.recheckEvidence(audioInput, planned.plan), /ANALYSIS_STALE/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("headless decision service loads current project and brief and rejects project drift", async () => {
  const f = await fixture();
  try {
    const { HeadlessDecisionPlanService } = await import("../../../apps/mcp-server/src/headless-decision-plan.js");
    let snapshot = structuredClone(f.request.snapshot);
    const service = new HeadlessDecisionPlanService({
      readProject: async () => structuredClone(snapshot),
      storeForProject: () => f.briefStore,
      artifacts: f.artifacts,
      index: f.index,
      currentProvider: () => f.request.speechContext.provider,
      verifySource: verifyLocalMediaSource,
    });
    const { snapshot: _snapshot, brief: _brief, accepted: _accepted, speechContext, vadContext, ...input } = f.request;
    const result = await service.plan(input);
    assert.equal(result.status, "available");
    if (result.status !== "available") return;
    await service.recheckEvidence(input, result.plan);
    await writeFile(f.path, "changed after edit");
    await assert.rejects(service.recheckEvidence(input, result.plan), /MEDIA_CHANGED/);
    await writeFile(f.path, "source bytes");
    const uncertain = await service.executeAcceptedPlan(input, result.plan.planDigest, async () => {
      await writeFile(f.path, "changed after commit");
      return { undoId: "undo-fixture" };
    }, async () => {});
    assert.equal(uncertain.status, "applied-unverified");
    assert.equal(uncertain.edit.undoId, "undo-fixture");
    await writeFile(f.path, "source bytes");
    const drifted = await service.executeAcceptedPlan(input, result.plan.planDigest, async () => ({ undoId: "undo-drift" }), async () => { throw new Error("readback mismatch"); });
    assert.equal(drifted.status, "applied-unverified");
    assert.equal(drifted.edit.undoId, "undo-drift");
    let readbacks = 0;
    const laterDrift = await service.executeAcceptedPlan(input, result.plan.planDigest, async () => ({ undoId: "undo-late-drift" }), async () => {
      if (++readbacks === 2) throw new Error("readback changed during evidence checks");
    });
    assert.equal(laterDrift.status, "applied-unverified");
    assert.equal(laterDrift.edit.undoId, "undo-late-drift");
    assert.equal(readbacks, 2);
    await assert.rejects(service.executeAcceptedPlan(input, result.plan.planDigest, async () => { throw new Error("before commit"); }, async () => {}), /before commit/);
    const { AgentVideoRuntime } = await import("../../../packages/runtime/src/index.js");
    const { InMemoryEditorAdapter } = await import("../../../packages/testkit/src/index.js");
    const { createMcpServer } = await import("../../../apps/mcp-server/src/server.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = createMcpServer(new AgentVideoRuntime(new InMemoryEditorAdapter({ projectId: "fixture", projectName: "Fixture", timelineId: "t", timelineName: "Main", clips: [] })), { headlessDecisionPlans: service });
    const client = new Client({ name: "decision-test", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(st); await client.connect(ct);
      const response = await client.callTool({ name: "headless.decision.plan", arguments: input });
      assert.notEqual(response.isError, true);
      const result = JSON.parse((response.content as Array<{ text: string }>)[0]!.text);
      assert.equal(result.status, "available");
      assert.equal(result.plan.reviewRequired, true);
      assert.ok(result.plan.decisions.every((decision: { support: string }) => decision.support === "unavailable" || decision.support === "no-op"));
      const correctedInput = { ...input, caption: { ...input.caption, wordCorrections: [{ wordIndex: 0, text: "Welcome" }] } };
      const correctedResponse = await client.callTool({ name: "headless.decision.plan", arguments: correctedInput });
      assert.notEqual(correctedResponse.isError, true);
      const corrected = JSON.parse((correctedResponse.content as Array<{ text: string }>)[0]!.text);
      assert.equal(corrected.status, "available");
      const caption = corrected.plan.decisions.find((decision: { kind: string }) => decision.kind === "caption");
      assert.equal(caption.group.words[0].text, "Welcome"); assert.equal(caption.group.words[0].originalText, "Hello.");
      assert.notEqual(corrected.plan.planDigest, result.plan.planDigest);
    } finally { await client.close(); await server.close(); }
    const evidenceBound = new HeadlessDecisionPlanService({ readProject: async () => structuredClone(snapshot),
      storeForProject: () => f.briefStore, artifacts: f.artifacts, verifySource: verifyLocalMediaSource, index: f.index, currentProvider: () => f.request.speechContext.provider });
    await f.index.save({ ...f.record, audio: { integratedLufs: -20, truePeakDb: -2, silenceMs: 10 } });
    assert.equal((await evidenceBound.plan(input)).status, "available");
    await f.index.save({ ...f.record, speech: { ...f.record.speech, words: [{ text: "changed", start: 1, end: 2, confidence: 0.98 }] } });
    assert.equal((await evidenceBound.plan(input)).status, "unavailable");
    await f.index.save(f.record);
    let evidenceReads = 0;
    const changingEvidence = new HeadlessDecisionPlanService({ readProject: async () => {
      if (++evidenceReads === 2) await f.index.save({ ...f.record, speech: { ...f.record.speech, words: [] } });
      return structuredClone(snapshot);
    }, storeForProject: () => f.briefStore, artifacts: f.artifacts, verifySource: verifyLocalMediaSource, index: f.index, currentProvider: () => f.request.speechContext.provider });
    assert.equal((await changingEvidence.plan(input)).status, "unavailable");
    await f.index.save(f.record);
    const racing = new HeadlessDecisionPlanService({ readProject: async () => {
      const observed = structuredClone(snapshot);
      snapshot = { ...snapshot, revision: { ...snapshot.revision, sequence: 2 } };
      return observed;
    }, storeForProject: () => f.briefStore, artifacts: f.artifacts, index: f.index, verifySource: verifyLocalMediaSource, currentProvider: () => f.request.speechContext.provider });
    const stale = await racing.plan(input);
    assert.equal(stale.status, "unavailable");
    assert.match(stale.reason, /STALE/);
    snapshot = structuredClone(f.request.snapshot);
    let reads = 0;
    const briefRace = new HeadlessDecisionPlanService({ readProject: async () => {
      if (++reads === 2) await f.briefStore.revise("p", f.draft.digest, { ...f.request.brief, theme: "changed" });
      return structuredClone(snapshot);
    }, storeForProject: () => f.briefStore, artifacts: f.artifacts, index: f.index, verifySource: verifyLocalMediaSource, currentProvider: () => f.request.speechContext.provider });
    assert.equal((await briefRace.plan(input)).status, "unavailable");
    snapshot = structuredClone(f.request.snapshot);
    assert.equal((await service.plan(input)).status, "unavailable");
    assert.deepEqual(f.request.speechContext, speechContext);
    assert.deepEqual(f.request.vadContext, vadContext);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("caption corrections are not silently dropped when captions lack evidence or are omitted", async () => {
  const f = await fixture();
  try {
    const caption = { ...f.request.caption, wordCorrections: [{ wordIndex: 0, text: "Welcome" }] };
    const withoutSpeech = { ...f.request, caption, speechRef: undefined, speechContext: undefined };
    const missing = await createEditDecisionPlan(withoutSpeech, f.artifacts, verifyLocalMediaSource, f.briefStore);
    assert.equal(missing.status, "unavailable");
    if (missing.status === "unavailable") assert.match(missing.reason, /correction/i);
    const brief = { ...f.request.brief, captionPolicy: { kind: "specified" as const, value: "none" } };
    const store = new JsonCreativeBriefStore(join(f.dir, "omit-corrections.json"));
    const draft = await store.create("p", brief); await store.accept("p", draft.digest);
    const omitted = await createEditDecisionPlan({ ...f.request, brief, accepted: acceptCreativeBrief(brief), caption }, f.artifacts, verifyLocalMediaSource, store);
    assert.equal(omitted.status, "unavailable");
    if (omitted.status === "unavailable") assert.match(omitted.reason, /correction/i);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("native cut handoff binds the current plan and rejects changed target and evidence", async () => {
  const { prepareNativeCutHandoff } = await import("../../../packages/runtime/src/planning/native-plan-handoff.js");
  const f = await fixture();
  try {
    const result = await createEditDecisionPlan(f.request, f.artifacts, verifyLocalMediaSource, f.briefStore);
    assert.equal(result.status, "available"); if (result.status !== "available") return;
    const index = result.plan.decisions.findIndex((item) => item.kind === "cut");
    assert.ok(index >= 0);
    const target = { libraryId: "library", eventId: "event", projectId: "p", sequenceId: "t" };
    const proposal = await prepareNativeCutHandoff(f.request, result.plan, index, target, f.artifacts, verifyLocalMediaSource, f.briefStore);
    assert.equal(proposal.status, "proposed");
    if (proposal.status !== "proposed") return;
    assert.equal(proposal.operation.type, "delete-range");
    assert.equal(proposal.planDigest, result.plan.planDigest);
    assert.equal(proposal.target.libraryId, "library");
    assert.equal(proposal.authorization, "not-authorized");
    const cut = result.plan.decisions[index]!;
    assert.equal(cut.kind, "cut");
    if (cut.kind !== "cut") return;
    assert.deepEqual(proposal.sourceRange, cut.candidate.sourceRange);
    assert.deepEqual(proposal.operation.start, cut.range.startTime);
    const repeated = await prepareNativeCutHandoff(f.request, result.plan, index, target, f.artifacts, verifyLocalMediaSource, f.briefStore);
    assert.equal(repeated.status, "proposed");
    if (repeated.status === "proposed") assert.equal(repeated.operationId, proposal.operationId);
    const differentLibrary = await prepareNativeCutHandoff(f.request, result.plan, index, { ...target, libraryId: "other" }, f.artifacts, verifyLocalMediaSource, f.briefStore);
    assert.equal(differentLibrary.status, "proposed");
    if (differentLibrary.status === "proposed") assert.notEqual(differentLibrary.operationId, proposal.operationId);
    assert.notEqual((await prepareNativeCutHandoff(f.request, result.plan, index, { ...target, sequenceId: "other" }, f.artifacts, verifyLocalMediaSource, f.briefStore)).status, "proposed");
    const changed = structuredClone(result.plan); changed.decisions.splice(index, 1);
    assert.notEqual((await prepareNativeCutHandoff(f.request, changed, index, target, f.artifacts, verifyLocalMediaSource, f.briefStore)).status, "proposed");
    const unavailableArtifacts = { put: f.artifacts.put.bind(f.artifacts), get: async () => undefined };
    assert.equal((await prepareNativeCutHandoff(f.request, result.plan, index, target, unavailableArtifacts, verifyLocalMediaSource, f.briefStore)).status, "unavailable");
    const tamperedArtifacts = { put: f.artifacts.put.bind(f.artifacts), get: async () => new Uint8Array([1, 2, 3]) };
    assert.equal((await prepareNativeCutHandoff(f.request, result.plan, index, target, tamperedArtifacts, verifyLocalMediaSource, f.briefStore)).status, "unavailable");
    const staleRevision = structuredClone(f.request);
    staleRevision.revision.id = "stale";
    assert.equal((await prepareNativeCutHandoff(staleRevision, result.plan, index, target, f.artifacts, verifyLocalMediaSource, f.briefStore)).status, "unavailable");
    const changedProvider = structuredClone(f.request);
    changedProvider.speechContext.provider.model = "different-model";
    assert.equal((await prepareNativeCutHandoff(changedProvider, result.plan, index, target, f.artifacts, verifyLocalMediaSource, f.briefStore)).status, "unavailable");
    await writeFile(f.path, "changed source");
    assert.notEqual((await prepareNativeCutHandoff(f.request, result.plan, index, target, f.artifacts, verifyLocalMediaSource, f.briefStore)).status, "proposed");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("native cut handoff snapshots inputs and excludes non-cut decisions", async () => {
  const { prepareNativeCutHandoff } = await import("../../../packages/runtime/src/planning/native-plan-handoff.js");
  const f = await fixture();
  try {
    const result = await createEditDecisionPlan(f.request, f.artifacts, verifyLocalMediaSource, f.briefStore);
    assert.equal(result.status, "available"); if (result.status !== "available") return;
    const index = result.plan.decisions.findIndex((item) => item.kind === "cut");
    const captionIndex = result.plan.decisions.findIndex((item) => item.kind === "caption");
    const target = { libraryId: "library", eventId: "event", projectId: "p", sequenceId: "t" };
    assert.equal((await prepareNativeCutHandoff(f.request, result.plan, captionIndex, target, f.artifacts, verifyLocalMediaSource, f.briefStore)).status, "unavailable");
    const pending = prepareNativeCutHandoff(f.request, result.plan, index, target, f.artifacts, async (source) => {
      target.libraryId = "changed";
      result.plan.planDigest = "changed";
      await verifyLocalMediaSource(source);
    }, f.briefStore);
    const proposal = await pending;
    assert.equal(proposal.status, "proposed");
    if (proposal.status === "proposed") {
      assert.equal(proposal.target.libraryId, "library");
      assert.notEqual(proposal.planDigest, "changed");
      assert.match(proposal.operationId, /^sha256:[a-f0-9]{64}$/);
    }
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("native cut proposal revalidation detects changed operation, target and evidence", async () => {
  const { prepareNativeCutHandoff, assertNativeCutHandoffCurrent } = await import("../../../packages/runtime/src/planning/native-plan-handoff.js");
  const f = await fixture();
  try {
    const planned = await createEditDecisionPlan(f.request, f.artifacts, verifyLocalMediaSource, f.briefStore);
    assert.equal(planned.status, "available"); if (planned.status !== "available") return;
    const index = planned.plan.decisions.findIndex((item) => item.kind === "cut");
    const target = { libraryId: "library", eventId: "event", projectId: "p", sequenceId: "t" };
    const proposal = await prepareNativeCutHandoff(f.request, planned.plan, index, target, f.artifacts, verifyLocalMediaSource, f.briefStore);
    assert.equal(proposal.status, "proposed"); if (proposal.status !== "proposed") return;
    assert.equal((await assertNativeCutHandoffCurrent(f.request, planned.plan, index, target, proposal, f.artifacts, verifyLocalMediaSource, f.briefStore)).status, "current");
    const changed = structuredClone(proposal); changed.operation.end.value = "999";
    assert.equal((await assertNativeCutHandoffCurrent(f.request, planned.plan, index, target, changed, f.artifacts, verifyLocalMediaSource, f.briefStore)).status, "stale");
    const changedSourceRange = structuredClone(proposal); changedSourceRange.sourceRange.start = 0;
    assert.equal((await assertNativeCutHandoffCurrent(f.request, planned.plan, index, target, changedSourceRange, f.artifacts, verifyLocalMediaSource, f.briefStore)).status, "stale");
    const changedWhileChecking = structuredClone(proposal); changedWhileChecking.operation.end.value = "999";
    const checked = await assertNativeCutHandoffCurrent(f.request, planned.plan, index, target, changedWhileChecking, f.artifacts, async (source) => {
      changedWhileChecking.operation.end.value = proposal.operation.end.value;
      await verifyLocalMediaSource(source);
    }, f.briefStore);
    assert.equal(checked.status, "stale");
    assert.equal((await assertNativeCutHandoffCurrent(f.request, planned.plan, index, { ...target, libraryId: "other" }, proposal, f.artifacts, verifyLocalMediaSource, f.briefStore)).status, "stale");
    await writeFile(f.path, "changed source");
    assert.equal((await assertNativeCutHandoffCurrent(f.request, planned.plan, index, target, proposal, f.artifacts, verifyLocalMediaSource, f.briefStore)).status, "stale");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("native range preview requires matching target, revision, range and live token", async () => {
  const { prepareNativeCutHandoff, checkNativeCutPreview } = await import("../../../packages/runtime/src/planning/native-plan-handoff.js");
  const { subtractRationalTimes } = await import("../../../packages/runtime/src/timeline/rational-time.js");
  const f = await fixture();
  try {
    const planned = await createEditDecisionPlan(f.request, f.artifacts, verifyLocalMediaSource, f.briefStore);
    assert.equal(planned.status, "available"); if (planned.status !== "available") return;
    const index = planned.plan.decisions.findIndex((item) => item.kind === "cut");
    const target = { libraryId: "library", eventId: "event", projectId: "p", sequenceId: "t" };
    const proposal = await prepareNativeCutHandoff(f.request, planned.plan, index, target, f.artifacts, verifyLocalMediaSource, f.briefStore);
    assert.equal(proposal.status, "proposed"); if (proposal.status !== "proposed") return;
    const observed = { ...target, revision: "r1", targetIdentity: "native-clip", sequenceStart: { value: "0", timescale: "1" }, sequenceDuration: { value: "10", timescale: "1" } };
    const removed = subtractRationalTimes(proposal.operation.end, proposal.operation.start);
    const preview = { previewToken: "token", operation: "delete-range", range: { start: proposal.operation.start, end: proposal.operation.end }, beforeDuration: observed.sequenceDuration, expectedAfterDuration: subtractRationalTimes(observed.sequenceDuration, removed), sequenceId: "t", revision: "r1", targetIdentity: "native-clip", expiresAt: "2027-01-01T00:00:00Z" };
    const now = Date.parse("2026-12-01T00:00:00Z");
    assert.deepEqual(checkNativeCutPreview(proposal, observed, preview, now), {
      status: "matched", evidence: "caller-supplied", authorization: "not-authorized",
    });
    const fabricated = { ...observed, targetIdentity: "fabricated-observation" };
    assert.deepEqual(checkNativeCutPreview(proposal, fabricated, { ...preview, targetIdentity: fabricated.targetIdentity }, now), {
      status: "matched", evidence: "caller-supplied", authorization: "not-authorized",
    });
    assert.equal(proposal.authorization, "not-authorized");
    for (const altered of [
      { ...proposal, operationId: "sha256:" + "0".repeat(64) },
      { ...proposal, planDigest: "sha256:" + "1".repeat(64) },
      { ...proposal, decisionIndex: proposal.decisionIndex + 1 },
      { ...proposal, analysisRef: { ...proposal.analysisRef, artifactDigest: "sha256:" + "2".repeat(64) } },
      { ...proposal, source: { ...proposal.source, sourceDigest: "f".repeat(64) } },
      { ...proposal, sourceRange: { ...proposal.sourceRange, start: proposal.sourceRange.start + 0.1 } },
    ]) {
      assert.equal(checkNativeCutPreview(altered, observed, preview, now).status, "unavailable");
    }
    assert.equal(checkNativeCutPreview(proposal, observed, { ...preview, beforeDuration: { value: "100", timescale: "10" } }, now).status, "matched");
    assert.equal(checkNativeCutPreview(proposal, { ...observed, libraryId: "other" }, preview, now).status, "unavailable");
    assert.equal(checkNativeCutPreview(proposal, observed, { ...preview, targetIdentity: undefined }, now).status, "unavailable");
    assert.equal(checkNativeCutPreview(proposal, observed, { ...preview, revision: "stale" }, now).status, "unavailable");
    assert.equal(checkNativeCutPreview(proposal, observed, { ...preview, range: { ...preview.range, end: { value: "999", timescale: "1" } } }, now).status, "unavailable");
    assert.equal(checkNativeCutPreview(proposal, observed, { ...preview, expiresAt: "2026-11-01T00:00:00Z" }, now).status, "unavailable");
    assert.equal(checkNativeCutPreview(proposal, observed, { ...preview, beforeDuration: { value: "11", timescale: "1" } }, now).status, "unavailable");
    assert.equal(checkNativeCutPreview(proposal, observed, { ...preview, expectedAfterDuration: { value: "10", timescale: "1" } }, now).status, "unavailable");
    assert.equal(checkNativeCutPreview(proposal, { ...observed, sequenceStart: { value: "20", timescale: "1" } }, preview, now).status, "unavailable");
    assert.equal(checkNativeCutPreview(proposal, { ...observed, sequenceDuration: { value: "0", timescale: "1" } }, preview, now).status, "unavailable");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("planning rejects missing speech evidence at the final brief check", async () => {
  const f = await fixture();
  try {
    let reads = 0;
    let missing = false;
    const store = Object.create(f.briefStore) as typeof f.briefStore;
    store.read = async (projectId) => {
      const result = await f.briefStore.read(projectId);
      if (++reads === 2) missing = true;
      return result;
    };
    const artifacts = {
      put: f.artifacts.put.bind(f.artifacts),
      get: async (digest: string) => missing ? undefined : f.artifacts.get(digest),
    };
    const result = await createEditDecisionPlan(f.request, artifacts, verifyLocalMediaSource, store);
    assert.equal(result.status, "unavailable");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("planning rechecks brief after the final evidence reads", async () => {
  const f = await fixture();
  try {
    let reads = 0;
    let changed = false;
    const store = Object.create(f.briefStore) as typeof f.briefStore;
    store.read = async (projectId) => {
      const result = await f.briefStore.read(projectId);
      reads++;
      return changed ? { ...result, state: "draft" as const } : result;
    };
    const artifacts = {
      put: f.artifacts.put.bind(f.artifacts),
      get: async (digest: string) => {
        if (reads >= 2) changed = true;
        return f.artifacts.get(digest);
      },
    };
    const result = await createEditDecisionPlan(f.request, artifacts, verifyLocalMediaSource, store);
    assert.equal(result.status, "unavailable");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("brief conformance requires a verified artifact bound to the approved target and revision", async () => {
  const { assessBriefArtifact } = await import("../../../packages/runtime/src/planning/brief-conformance.js");
  const f = await fixture();
  try {
    const planned = await createEditDecisionPlan(f.request, f.artifacts, verifyLocalMediaSource, f.briefStore);
    assert.equal(planned.status, "available"); if (planned.status !== "available") return;
    const finalRevision = { ...f.request.revision, id: "r2", sequence: 2 };
    const execution = { status: "verified" as const, planDigest: planned.plan.planDigest, baseRevision: f.request.revision, finalRevision };
    const artifact = { status: "passed" as const, target: { projectId: "p", sequenceId: "t" }, revision: finalRevision,
      fileDigest: `sha256:${"a".repeat(64)}`, durationSeconds: 6, width: 1080, height: 1920 };
    const result = assessBriefArtifact(f.request.brief, f.request.accepted, planned.plan, execution, artifact);
    assert.equal(result.status, "incomplete");
    assert.equal(result.checks.find((check) => check.name === "duration")?.status, "passed");
    assert.equal(result.checks.find((check) => check.name === "aspect-ratio")?.status, "passed");
    assert.equal(result.checks.find((check) => check.name === "duration")?.nextStep, undefined);
    for (const name of ["source-coverage", "music", "captions"] as const) {
      assert.ok(result.checks.find((check) => check.name === name)?.nextStep);
    }
    assert.equal(result.nativeAcceptance, "unavailable");
    assert.equal(result.binding?.artifactDigest, artifact.fileDigest);
    assert.equal(assessBriefArtifact(f.request.brief, f.request.accepted, planned.plan, execution, { ...artifact, fileDigest: "a".repeat(64) }).checks[0]?.status, "passed");
    for (const alteredExecution of [
      { ...execution, status: "unavailable" as const },
      { ...execution, planDigest: "other" },
      { ...execution, baseRevision: { ...execution.baseRevision, id: "other" } },
    ]) {
      assert.equal(assessBriefArtifact(f.request.brief, f.request.accepted, planned.plan, alteredExecution, artifact).checks[0]?.status, "unavailable");
      assert.ok(assessBriefArtifact(f.request.brief, f.request.accepted, planned.plan, alteredExecution, artifact).checks[0]?.nextStep);
    }
    for (const invalidRevision of [null, { ...finalRevision, id: "" }, { ...finalRevision, sequence: -1 }, { ...finalRevision, timestamp: "" }]) {
      const rejected = assessBriefArtifact(f.request.brief, f.request.accepted, planned.plan,
        { ...execution, finalRevision: invalidRevision as any }, { ...artifact, revision: invalidRevision as any });
      assert.equal(rejected.checks.find((check) => check.name === "duration")?.status, "unavailable");
      assert.equal(rejected.binding, undefined);
    }
    const changedSource = structuredClone(planned.plan);
    changedSource.source.mediaId = "other-source";
    const changedDecision = structuredClone(planned.plan);
    changedDecision.decisions[0]!.rationale = "changed after approval";
    for (const changedPlan of [changedSource, changedDecision]) {
      const rejected = assessBriefArtifact(f.request.brief, f.request.accepted, changedPlan, execution, artifact);
      assert.equal(rejected.checks.find((check) => check.name === "duration")?.status, "unavailable");
      assert.equal(rejected.binding, undefined);
    }
    const withoutSourceDigest = structuredClone(planned.plan);
    delete withoutSourceDigest.source.sourceDigest;
    const withoutOccurrence = { ...structuredClone(planned.plan), occurrenceId: "" };
    for (const malformed of [withoutSourceDigest, withoutOccurrence]) {
      const { planDigest: _old, ...content } = malformed;
      const encoded = JSON.stringify(content, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : item);
      const resigned = { ...content, planDigest: `sha256:${createHash("sha256").update(encoded).digest("hex")}` };
      const rejected = assessBriefArtifact(f.request.brief, f.request.accepted, resigned, { ...execution, planDigest: resigned.planDigest }, artifact);
      assert.equal(rejected.checks.find((check) => check.name === "duration")?.status, "unavailable");
    }
    const malformedPlan = { ...planned.plan, planDigest: "not-a-digest" };
    assert.equal(assessBriefArtifact(f.request.brief, f.request.accepted, malformedPlan,
      { ...execution, planDigest: malformedPlan.planDigest }, artifact).checks[0]?.status, "unavailable");
    const revisedBrief = { ...f.request.brief, theme: "changed" };
    assert.equal(assessBriefArtifact(revisedBrief, f.request.accepted, planned.plan, execution, artifact).checks[0]?.status, "unavailable");
    for (const changed of [
      { ...artifact, target: { ...artifact.target, sequenceId: "wrong" } },
      { ...artifact, revision: { ...artifact.revision, sequence: 999 } },
      { ...artifact, status: "failed" as const },
      { ...artifact, fileDigest: "" },
    ]) {
      const rejected = assessBriefArtifact(f.request.brief, f.request.accepted, planned.plan, execution, changed);
      assert.equal(rejected.checks.find((check) => check.name === "duration")?.status, "unavailable");
      assert.equal(rejected.nativeAcceptance, "unavailable");
    }
    const failed = assessBriefArtifact(f.request.brief, f.request.accepted, planned.plan, execution, { ...artifact, durationSeconds: 20, width: 1920, height: 1080 });
    assert.equal(failed.checks.find((check) => check.name === "duration")?.status, "failed");
    assert.equal(failed.checks.find((check) => check.name === "aspect-ratio")?.status, "failed");
    assert.match(failed.checks.find((check) => check.name === "duration")?.nextStep ?? "", /review/i);
    assert.match(failed.checks.find((check) => check.name === "aspect-ratio")?.nextStep ?? "", /review/i);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("headless execution retains reviewed evidence when caller mutates its request", async () => {
  const f = await fixture();
  try {
    const { HeadlessDecisionPlanService } = await import("../../../apps/mcp-server/src/headless-decision-plan.js");
    const service = new HeadlessDecisionPlanService({ readProject: async () => structuredClone(f.request.snapshot),
      storeForProject: () => f.briefStore, artifacts: f.artifacts, index: f.index,
      verifySource: verifyLocalMediaSource, currentProvider: () => f.request.speechContext.provider });
    const { snapshot: _snapshot, brief: _brief, accepted: _accepted, speechContext: _speechContext, vadContext: _vadContext, ...input } = structuredClone(f.request);
    const planned = await service.plan(input);
    assert.equal(planned.status, "available"); if (planned.status !== "available") return;
    const result = await service.executeAcceptedPlan(input, planned.plan.planDigest, async () => {
      delete (input as { speechRef?: unknown }).speechRef;
      delete (input as { vadRef?: unknown }).vadRef;
      await f.index.save({ ...f.record, speech: { ...f.record.speech, words: [] } });
      return { undoId: "undo-fixture" };
    }, async () => {});
    assert.equal(result.status, "applied-unverified");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("headless planning snapshots request before project reads", async () => {
  const f = await fixture();
  try {
    const { HeadlessDecisionPlanService } = await import("../../../apps/mcp-server/src/headless-decision-plan.js");
    const { snapshot: _snapshot, brief: _brief, accepted: _accepted, speechContext: _speechContext, vadContext: _vadContext, ...input } = structuredClone(f.request);
    const common = { storeForProject: () => f.briefStore, artifacts: f.artifacts, index: f.index,
      verifySource: verifyLocalMediaSource, currentProvider: () => f.request.speechContext.provider };
    const expected = await new HeadlessDecisionPlanService({ ...common, readProject: async () => structuredClone(f.request.snapshot) }).plan(input);
    const observed = await new HeadlessDecisionPlanService({ ...common, readProject: async () => {
      input.caption.maxWordsPerGroup = 1;
      return structuredClone(f.request.snapshot);
    } }).plan(input);
    assert.deepEqual(observed, expected);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("headless evidence recheck rejects provider drift during final index read", async () => {
  const f = await fixture();
  try {
    const { HeadlessDecisionPlanService } = await import("../../../apps/mcp-server/src/headless-decision-plan.js");
    const { snapshot: _snapshot, brief: _brief, accepted: _accepted, speechContext: _speechContext, vadContext: _vadContext, ...input } = structuredClone(f.request);
    const provider = f.request.speechContext.provider;
    const common = { readProject: async () => structuredClone(f.request.snapshot), storeForProject: () => f.briefStore,
      artifacts: f.artifacts, verifySource: verifyLocalMediaSource };
    const planned = await new HeadlessDecisionPlanService({ ...common, index: f.index, currentProvider: () => provider }).plan(input);
    assert.equal(planned.status, "available"); if (planned.status !== "available") return;
    let changed = false;
    let reads = 0;
    const index = Object.create(f.index) as typeof f.index;
    index.load = async (source) => {
      const result = await f.index.load(source);
      if (++reads === 4) changed = true;
      return result;
    };
    const service = new HeadlessDecisionPlanService({ ...common, index,
      currentProvider: (kind) => kind === "speech" && changed ? { ...provider, version: "changed" } : provider });
    await assert.rejects(service.recheckEvidence(input, planned.plan), /ANALYSIS_STALE_PROVIDER/);
    changed = false;
    const executing = new HeadlessDecisionPlanService({ ...common, index: f.index,
      currentProvider: (kind) => kind === "speech" && changed ? { ...provider, version: "changed" } : provider });
    let verifies = 0;
    const outcome = await executing.executeAcceptedPlan(input, planned.plan.planDigest, async () => ({ undoId: "undo-provider" }), async () => {
      if (++verifies === 2) changed = true;
    });
    assert.equal(outcome.status, "applied-unverified");
    assert.equal(outcome.edit.undoId, "undo-provider");
    let artifactReads = 0;
    const racingArtifacts = { put: f.artifacts.put.bind(f.artifacts), get: async (digest: string) => {
      const bytes = await f.artifacts.get(digest);
      if (++artifactReads === 4) await f.index.save({ ...f.record, speech: { ...f.record.speech, words: [] } });
      return bytes;
    } };
    const racingIndex = new HeadlessDecisionPlanService({ ...common, artifacts: racingArtifacts, index: f.index, currentProvider: () => provider });
    await assert.rejects(racingIndex.recheckEvidence(input, planned.plan), /ANALYSIS_STALE/);
    await f.index.save(f.record);
    let armed = false;
    artifactReads = 0;
    const postCommitArtifacts = { put: f.artifacts.put.bind(f.artifacts), get: async (digest: string) => {
      const bytes = await f.artifacts.get(digest);
      if (armed && ++artifactReads === 4) await f.index.save({ ...f.record, speech: { ...f.record.speech, words: [] } });
      return bytes;
    } };
    const postCommit = new HeadlessDecisionPlanService({ ...common, artifacts: postCommitArtifacts, index: f.index, currentProvider: () => provider });
    const changedIndex = await postCommit.executeAcceptedPlan(input, planned.plan.planDigest, async () => {
      armed = true;
      return { undoId: "undo-index" };
    }, async () => {});
    assert.equal(changedIndex.status, "applied-unverified");
    assert.equal(changedIndex.edit.undoId, "undo-index");
    await f.index.save(f.record);
    let assetChanged = false;
    const asyncProvider = new HeadlessDecisionPlanService({ ...common, index: f.index, currentProvider: (async () => {
      await Promise.resolve();
      if (assetChanged) throw new Error("ANALYSIS_STALE_PROVIDER: model asset changed");
      return provider;
    }) });
    const asyncPlan = await asyncProvider.plan(input);
    assert.equal(asyncPlan.status, "available", asyncPlan.status === "unavailable" ? asyncPlan.reason : undefined);
    if (asyncPlan.status !== "available") return;
    const changedAsset = await asyncProvider.executeAcceptedPlan(input, asyncPlan.plan.planDigest, async () => {
      assetChanged = true;
      return { undoId: "undo-asset" };
    }, async () => {});
    assert.equal(changedAsset.status, "applied-unverified");
    assert.equal(changedAsset.edit.undoId, "undo-asset");
    assert.equal((await asyncProvider.plan(input)).status, "unavailable");
    let snapshot = structuredClone(f.request.snapshot);
    let projectReads = 0; let lateProviderCalls = 0;
    const projectRace = new HeadlessDecisionPlanService({ ...common, index: f.index,
      readProject: async () => { projectReads++; return structuredClone(snapshot); },
      currentProvider: async () => {
        if (projectReads >= 2 && ++lateProviderCalls === 5) snapshot.revision.sequence++;
        return provider;
      } });
    const changedProject = await projectRace.plan(input);
    assert.equal(changedProject.status, "unavailable");
    if (changedProject.status === "unavailable") assert.match(changedProject.reason, /STALE_CONTEXT/);
    let providerDrift = false; projectReads = 0;
    const lateBriefStore = Object.create(f.briefStore) as typeof f.briefStore;
    lateBriefStore.read = async (projectId) => {
      const record = await f.briefStore.read(projectId);
      if (projectReads >= 3) providerDrift = true;
      return record;
    };
    const providerRace = new HeadlessDecisionPlanService({ ...common, index: f.index,
      storeForProject: () => lateBriefStore,
      readProject: async () => { projectReads++; return structuredClone(f.request.snapshot); },
      currentProvider: async () => providerDrift ? { ...provider, version: "changed at final brief read" } : provider });
    const changedProviderAtFinalBrief = await providerRace.plan(input);
    assert.equal(changedProviderAtFinalBrief.status, "unavailable");
    if (changedProviderAtFinalBrief.status === "unavailable") assert.match(changedProviderAtFinalBrief.reason, /ANALYSIS_STALE_PROVIDER/);
    projectReads = 0; lateProviderCalls = 0;
    const briefRace = new HeadlessDecisionPlanService({ ...common, index: f.index,
      readProject: async () => { projectReads++; return structuredClone(f.request.snapshot); },
      currentProvider: async () => {
        if (projectReads >= 2 && ++lateProviderCalls === 5) await f.briefStore.revise("p", f.draft.digest, { ...f.request.brief, theme: "changed during provider verification" });
        return provider;
      } });
    const changedBrief = await briefRace.plan(input);
    assert.equal(changedBrief.status, "unavailable");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("headless execution preserves committed Undo data across verifier mutation", async () => {
  const f = await fixture();
  try {
    const { HeadlessDecisionPlanService } = await import("../../../apps/mcp-server/src/headless-decision-plan.js");
    const service = new HeadlessDecisionPlanService({ readProject: async () => structuredClone(f.request.snapshot),
      storeForProject: () => f.briefStore, artifacts: f.artifacts, index: f.index,
      verifySource: verifyLocalMediaSource, currentProvider: () => f.request.speechContext.provider });
    const { snapshot: _snapshot, brief: _brief, accepted: _accepted, speechContext: _speechContext, vadContext: _vadContext, ...input } = structuredClone(f.request);
    const planned = await service.plan(input);
    assert.equal(planned.status, "available"); if (planned.status !== "available") return;
    const original = { undoId: "original" };
    const result = await service.executeAcceptedPlan(input, planned.plan.planDigest, async () => original, async (edit) => {
      edit.undoId = "altered";
      original.undoId = "altered";
    });
    assert.equal(result.edit.undoId, "original");
    const uncloneable = await service.executeAcceptedPlan(input, planned.plan.planDigest,
      async () => ({ undoId: "recoverable", unsupported: () => {} }), async () => {});
    assert.equal(uncloneable.status, "applied-unverified");
    assert.equal(uncloneable.edit.undoId, "recoverable");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("optional filler observations bind speech and remain unavailable for execution", async () => {
  const f = await fixture();
  try {
    const speech = { ...f.record.speech, words: [
      { text: "Hello.", start: 1, end: 2, confidence: 0.98 },
      { text: "um,", start: 3, end: 3.3, confidence: 0.99 },
      { text: "uh,", start: 4, end: 4.3, confidence: 0.55 },
      { text: "Again", start: 5, end: 6, confidence: 0.96 },
    ], protectedSegments: [{ kind: "speech" as const, start: 3.9, end: 4.4 }] };
    await f.index.save({ ...f.record, speech });
    const speechRef = await pinAnalysisEvidence(f.index, f.artifacts, f.request.speechContext, verifyLocalMediaSource);
    const request = { ...f.request, speechRef, vadRef: undefined, vadContext: undefined };
    const original = structuredClone(request.snapshot);
    const normal = await createEditDecisionPlan(request, f.artifacts, verifyLocalMediaSource, f.briefStore);
    const observed = await createEditDecisionPlan({ ...request, includeFillerObservations: true }, f.artifacts, verifyLocalMediaSource, f.briefStore);
    assert.equal(normal.status, "available"); assert.equal(observed.status, "available");
    if (normal.status !== "available" || observed.status !== "available") return;
    assert.equal(normal.plan.decisions.some((item) => item.kind === "filler-observation"), false);
    const fillers = observed.plan.decisions.filter((item) => item.kind === "filler-observation");
    assert.equal(fillers.length, 2);
    assert.ok(fillers.every((item) => item.support === "unavailable" && item.reviewRequired === true));
    assert.deepEqual(fillers.map((item) => item.word.text), ["um,", "uh,"]);
    assert.ok(fillers.every((item) => item.analysisRef.artifactDigest === speechRef.artifactDigest));
    assert.ok(observed.plan.warnings.some((warning) => /not.*(safe|remov)/i.test(warning)));
    assert.notEqual(normal.plan.planDigest, observed.plan.planDigest);
    assert.deepEqual(request.snapshot, original);
    await writeFile(f.path, "changed source");
    assert.notEqual((await createEditDecisionPlan({ ...request, includeFillerObservations: true }, f.artifacts, verifyLocalMediaSource, f.briefStore)).status, "available");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
