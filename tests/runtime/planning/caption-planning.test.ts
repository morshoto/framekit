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

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "framekit-captions-"));
  const path = join(dir, "source.mov");
  await writeFile(path, "known source");
  const source = { mediaId: "m", source: path, sourceDigest: createHash("sha256").update("known source").digest("hex"), mediaKind: "video" as const, duration: 10 };
  const speech = { coverageProvenance: "provider" as const, schemaVersion: 1 as const, mediaId: "m", sourceIdentity: source, revision, provider,
    requestedRange: { start: 0, end: 10 }, observedRange: { start: 0, end: 10 }, sourceTimebase: { value: "1", timescale: "1000" }, capability: "transcription-only" as const,
    words: [{ text: "Hello", start: 1, end: 1.4, confidence: 0.98 }, { text: "world.", start: 1.5, end: 2, confidence: 0.96 }, { text: "Again", start: 3, end: 3.4, confidence: 0.6 }] };
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
  return { dir, path, source, ref, current, artifacts, snapshot, request };
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

test("trimmed boundaries and insufficient transcript coverage are explicit", async () => {
  const f = await fixture();
  try {
    const crossing = { ...f.snapshot.timeline.clips[0]!, sourceStart: 1.2, sourceStartTime: { value: "12", timescale: "10" }, duration: 8, durationTime: { value: "8", timescale: "1" } };
    const snapshot = { ...f.snapshot, timeline: { ...f.snapshot.timeline, clips: [crossing] } };
    const result = await planCaptionGroups({ ...f.request, snapshot }, f.ref, f.current, f.artifacts, verifyLocalMediaSource);
    assert.equal(result.status, "unavailable");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
