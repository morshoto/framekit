import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySemanticMediaIndexStore, InMemoryAnalysisArtifactStore, pinAnalysisEvidence, verifyLocalMediaSource } from "../../../packages/runtime/src/index.js";
import { planCaptionGroups } from "../../../packages/runtime/src/planning/caption-planning.js";

const revision = { id: "r1", sequence: 1, timestamp: "2026-01-01T00:00:00.000Z" };
const provider = { id: "speech", provider: "fixture", version: "1", model: "model-v1", configurationDigest: "config-v1" };

async function fixture(words = [{ text: "Hello", start: 1, end: 1.4, confidence: 0.98 }, { text: "world.", start: 1.5, end: 2, confidence: 0.96 }, { text: "Again", start: 3, end: 3.4, confidence: 0.6 }]) {
  const dir = await mkdtemp(join(tmpdir(), "framekit-captions-"));
  const path = join(dir, "source.mov");
  await writeFile(path, "known source");
  const source = { mediaId: "m", source: path, sourceDigest: createHash("sha256").update("known source").digest("hex"), mediaKind: "video" as const, duration: 10 };
  const speech = { coverageProvenance: "provider" as const, schemaVersion: 1 as const, mediaId: "m", sourceIdentity: source, revision, provider,
    requestedRange: { start: 0, end: 10 }, observedRange: { start: 0, end: 10 }, sourceTimebase: { value: "1", timescale: "1000" }, capability: "transcription-only" as const,
    words };
  const record = { mediaId: "m", source: path, sourceIdentity: source, analysisRevision: revision, speech,
    semantic: { subjects: [], scenes: [], environments: [], timeOfDay: [], moods: [], usableRanges: [] },
    analysis: [{ capability: "speech" as const, status: "analyzed" as const, provenance: { source, analyzer: provider, ranges: [{ start: 0, end: 10 }] } }] };
  const index = new InMemorySemanticMediaIndexStore();
  await index.save(record);
  const artifacts = new InMemoryAnalysisArtifactStore();
  const current = { kind: "speech" as const, source, provider, revision, range: { start: 0, end: 10 } };
  const ref = await pinAnalysisEvidence(index, artifacts, current, verifyLocalMediaSource);
  const snapshot = { projectId: "p", projectName: "P", revision, media: [source], timeline: { id: "t", name: "T", duration: 30, frameDuration: { value: "1", timescale: "10" },
    clips: [{ id: "clip", mediaId: "m", name: "Interview", start: 20, duration: 10, sourceStart: 0, sourceStartTime: { value: "0", timescale: "1" }, startTime: { value: "20", timescale: "1" }, durationTime: { value: "10", timescale: "1" }, track: 1 }], storyElements: [], captions: [], markers: [] } };
  const request = { snapshot, projectId: "p", timelineId: "t", revision, occurrenceId: "clip", style: "basic" as const, maxWordsPerGroup: 2, maxCharsPerLine: 20, maxLines: 2, emphasisWordIndices: [0] };
  return { dir, path, source, ref, current, artifacts, snapshot, request, index };
}

test("known words produce read-only frame-mapped caption groups and traceable emphasis", async () => {
  const f = await fixture();
  try {
    const before = structuredClone(f.request.snapshot);
    const result = await planCaptionGroups(f.request, f.ref, f.current, f.artifacts, verifyLocalMediaSource);
    assert.equal(result.status, "available");
    if (result.status !== "available") return;
    assert.deepEqual(f.request.snapshot, before);
    assert.equal(result.plan.reviewRequired, true);
    assert.equal(result.plan.groups.length, 2);
    assert.deepEqual(result.plan.groups[0]!.lines, ["Hello world."]);
    assert.equal(result.plan.groups[0]!.words[0]!.sequenceRange.start, 21);
    assert.ok(result.plan.groups[0]!.sequenceRange.startTime);
    assert.equal(result.plan.groups[0]!.emphasis[0]!.wordIndex, 0);
    assert.match(result.plan.groups[0]!.emphasis[0]!.reason, /review/i);
    assert.ok(result.plan.warnings.some((warning) => /confidence/i.test(warning)));
    assert.equal(result.plan.nativeTitleStatus, "unavailable");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("stale source and unsupported animation never produce a caption plan", async () => {
  const f = await fixture();
  try {
    assert.equal((await planCaptionGroups({ ...f.request, style: "animated" }, f.ref, f.current, f.artifacts, verifyLocalMediaSource)).status, "unsupported");
    const stale = { ...f.request, revision: { ...revision, sequence: 2 } };
    assert.equal((await planCaptionGroups(stale, f.ref, f.current, f.artifacts, verifyLocalMediaSource)).status, "unavailable");
    await writeFile(f.path, "changed source");
    assert.equal((await planCaptionGroups(f.request, f.ref, f.current, f.artifacts, verifyLocalMediaSource)).status, "unavailable");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("repinned source speech is remapped for a changed timeline revision", async () => {
  const f = await fixture();
  try {
    const next = { ...revision, id: "r2", sequence: 2 };
    const current = { ...f.current, revision: next };
    const ref = await pinAnalysisEvidence(f.index, f.artifacts, current, verifyLocalMediaSource);
    const moved = { ...f.snapshot.timeline.clips[0]!, start: 5, startTime: { value: "5", timescale: "1" } };
    const snapshot = { ...f.snapshot, revision: next, timeline: { ...f.snapshot.timeline, clips: [moved] } };
    const result = await planCaptionGroups({ ...f.request, snapshot, revision: next }, ref, current, f.artifacts, verifyLocalMediaSource);
    assert.equal(result.status, "available");
    if (result.status === "available") {
      assert.equal(result.plan.groups[0]!.words[0]!.sequenceRange.start, 6);
      assert.equal(result.plan.revision.id, "r2");
      assert.equal(result.plan.analysisRef.analysisRevision.id, "r1");
    }
    assert.equal((await planCaptionGroups({ ...f.request, snapshot, revision: next }, f.ref, current, f.artifacts, verifyLocalMediaSource)).status, "unavailable");
    await writeFile(f.path, "changed");
    assert.equal((await planCaptionGroups({ ...f.request, snapshot, revision: next }, ref, current, f.artifacts, verifyLocalMediaSource)).status, "unavailable");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("trimmed boundaries and insufficient transcript coverage are explicit", async () => {
  const f = await fixture();
  try {
    const crossing = { ...f.snapshot.timeline.clips[0]!, sourceStart: 1.2, sourceStartTime: { value: "12", timescale: "10" }, duration: 8, durationTime: { value: "8", timescale: "1" } };
    const snapshot = { ...f.snapshot, timeline: { ...f.snapshot.timeline, clips: [crossing] } };
    const result = await planCaptionGroups({ ...f.request, snapshot }, f.ref, f.current, f.artifacts, verifyLocalMediaSource);
    assert.equal(result.status, "unavailable");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});


test("trim and repeated occurrences map source words independently", async () => {
  const f = await fixture();
  try {
    const trimmed = { ...f.snapshot.timeline.clips[0]!, id: "trim", start: 10, startTime: { value: "10", timescale: "1" }, sourceStart: 1, sourceStartTime: { value: "1", timescale: "1" }, duration: 3, durationTime: { value: "3", timescale: "1" } };
    const repeated = { ...f.snapshot.timeline.clips[0]!, id: "repeat", start: 0, startTime: { value: "0", timescale: "1" } };
    const snapshot = { ...f.snapshot, timeline: { ...f.snapshot.timeline, clips: [trimmed, repeated] } };
    const first = await planCaptionGroups({ ...f.request, snapshot, occurrenceId: "trim" }, f.ref, f.current, f.artifacts, verifyLocalMediaSource);
    const second = await planCaptionGroups({ ...f.request, snapshot, occurrenceId: "repeat" }, f.ref, f.current, f.artifacts, verifyLocalMediaSource);
    assert.equal(first.status, "available"); assert.equal(second.status, "available");
    if (first.status === "available" && second.status === "available") {
      assert.equal(first.plan.groups[0]!.words[0]!.sequenceRange.start, 10);
      assert.equal(second.plan.groups[0]!.words[0]!.sequenceRange.start, 1);
    }
    const partial = { ...f.current, range: { start: 0, end: 2 } };
    assert.equal((await planCaptionGroups({ ...f.request, snapshot, occurrenceId: "trim" }, f.ref, partial, f.artifacts, verifyLocalMediaSource)).status, "unavailable");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("overlapping frame-rounded groups are unavailable rather than silently shifted", async () => {
  const f = await fixture([{ text: "First.", start: 1.01, end: 1.04, confidence: 0.9 }, { text: "Next", start: 1.05, end: 1.08, confidence: 0.9 }]);
  try {
    const result = await planCaptionGroups({ ...f.request, maxWordsPerGroup: 1 }, f.ref, f.current, f.artifacts, verifyLocalMediaSource);
    assert.equal(result.status, "unavailable");
    if (result.status === "unavailable") assert.match(result.reason, /overlap/i);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("regroups words when a different frame-safe boundary satisfies the format", async () => {
  const f = await fixture([{ text: "A", start: 1, end: 1.1, confidence: 0.9 }, { text: "B", start: 1.1, end: 1.19, confidence: 0.9 },
    { text: "C", start: 1.19, end: 1.25, confidence: 0.9 }, { text: "D", start: 1.3, end: 1.4, confidence: 0.9 }]);
  try {
    const result = await planCaptionGroups(f.request, f.ref, f.current, f.artifacts, verifyLocalMediaSource);
    assert.equal(result.status, "available");
    if (result.status !== "available") return;
    assert.deepEqual(result.plan.groups.map((group) => group.lines), [["A"], ["B C"], ["D"]]);
    assert.deepEqual(result.plan.groups.flatMap((group) => group.words.map((word) => word.sourceRange.start)), [1, 1.1, 1.19, 1.3]);
    assert.ok(result.plan.warnings.some((warning) => /regroup/i.test(warning)));
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("an empty transcript is reported and never creates placeholder captions", async () => {
  const f = await fixture([]);
  try {
    const result = await planCaptionGroups({ ...f.request, emphasisWordIndices: [] }, f.ref, f.current, f.artifacts, verifyLocalMediaSource);
    assert.equal(result.status, "available");
    if (result.status === "available") {
      assert.deepEqual(result.plan.groups, []);
      assert.ok(result.plan.warnings.some((warning) => /no.*words/i.test(warning)));
    }
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("frame rounding is exposed alongside original word timing", async () => {
  const f = await fixture([{ text: "First", start: 1.01, end: 1.04, confidence: 0.9 }]);
  try {
    const result = await planCaptionGroups(f.request, f.ref, f.current, f.artifacts, verifyLocalMediaSource);
    assert.equal(result.status, "available");
    if (result.status === "available") {
      const word = result.plan.groups[0]!.words[0]!;
      assert.notEqual(word.sequenceRange.start, word.frameAlignedRange.start);
      assert.ok(result.plan.warnings.some((warning) => /round/i.test(warning)));
    }
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("caption planner is exported to runtime consumers", async () => {
  const runtime = await import("../../../packages/runtime/src/index.js");
  assert.equal(typeof (runtime as Record<string, unknown>).planCaptionGroups, "function");
});

test("caption planning fails closed if pinned bytes change between reads", async () => {
  const f = await fixture();
  try {
    const original = await f.artifacts.get(f.ref.artifactDigest);
    let reads = 0;
    const changed = { get: async () => ++reads === 1 ? original : Buffer.from("{}"), put: async () => {} };
    const result = await planCaptionGroups(f.request, f.ref, f.current, changed, verifyLocalMediaSource);
    assert.equal(result.status, "unavailable");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("reviewers can correct caption words without changing transcript evidence or timing", async () => {
  const f = await fixture();
  try {
    const original = await planCaptionGroups(f.request, f.ref, f.current, f.artifacts, verifyLocalMediaSource);
    const request = { ...f.request, wordCorrections: [{ wordIndex: 0, text: "Welcome" }] };
    const corrected = await planCaptionGroups(request, f.ref, f.current, f.artifacts, verifyLocalMediaSource);
    assert.equal(original.status, "available"); assert.equal(corrected.status, "available");
    if (original.status !== "available" || corrected.status !== "available") return;
    const oldWord = original.plan.groups[0]!.words[0]!; const newWord = corrected.plan.groups[0]!.words[0]!;
    assert.equal(newWord.text, "Welcome"); assert.equal(newWord.originalText, "Hello");
    assert.deepEqual(newWord.sourceRange, oldWord.sourceRange); assert.deepEqual(newWord.sequenceRange, oldWord.sequenceRange);
    assert.equal(corrected.plan.analysisRef.artifactDigest, f.ref.artifactDigest);
    assert.notEqual(corrected.plan.inputDigest, original.plan.inputDigest);
    assert.ok(corrected.plan.warnings.some((warning) => /correction.*review/i.test(warning)));
    assert.ok(corrected.plan.warnings.some((warning) => /confidence.*original/i.test(warning)));
    for (const wordCorrections of [[{ wordIndex: 99, text: "bad" }], [{ wordIndex: 0, text: "" }],
      [{ wordIndex: 0, text: "one" }, { wordIndex: 0, text: "two" }], [{ wordIndex: 0, text: "bad\ntext" }]]) {
      assert.notEqual((await planCaptionGroups({ ...f.request, wordCorrections }, f.ref, f.current, f.artifacts, verifyLocalMediaSource)).status, "available");
    }
    const trimmed = { ...f.snapshot.timeline.clips[0]!, sourceStart: 3, sourceStartTime: { value: "3", timescale: "1" }, duration: 1, durationTime: { value: "1", timescale: "1" } };
    const trimmedSnapshot = { ...f.snapshot, timeline: { ...f.snapshot.timeline, clips: [trimmed] } };
    const outside = await planCaptionGroups({ ...request, snapshot: trimmedSnapshot, emphasisWordIndices: [] }, f.ref, f.current, f.artifacts, verifyLocalMediaSource);
    assert.equal(outside.status, "unavailable");
    if (outside.status === "unavailable") assert.match(outside.reason, /corrected word.*outside/i);
    await writeFile(f.path, "changed source");
    assert.equal((await planCaptionGroups(request, f.ref, f.current, f.artifacts, verifyLocalMediaSource)).status, "unavailable");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
