import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemorySemanticMediaIndexStore } from "../../../packages/runtime/src/application/semantic-media-index-store.js";
import { InMemoryAnalysisArtifactStore, pinAnalysisEvidence, verifyAnalysisEvidence } from "../../../packages/runtime/src/planning/analysis-evidence.js";
import type { MediaUnderstanding } from "../../../packages/runtime/src/domain/media.js";

const source = { mediaId: "m1", source: "fixture.mov", sourceDigest: "sha256:source", mediaKind: "video" as const, duration: 10 };
const revision = { id: "r1", sequence: 1, timestamp: "2026-01-01T00:00:00.000Z" };
const provider = { id: "speech", provider: "fixture", version: "1", model: "model", configurationDigest: "sha256:config" };
const range = { start: 1, end: 4 };
const understanding: MediaUnderstanding = {
  mediaId: source.mediaId, source: source.source, sourceIdentity: source, analysisRevision: revision,
  semantic: { subjects: [], scenes: [], environments: [], timeOfDay: [], moods: [], usableRanges: [] },
  analysis: [{ capability: "speech", status: "analyzed", provenance: { source, analyzer: provider, ranges: [{ start: 0, end: 10 }] } }],
  speech: { schemaVersion: 1, mediaId: source.mediaId, sourceIdentity: source, revision, provider, requestedRange: { start: 0, end: 10 }, observedRange: { start: 0, end: 10 }, sourceTimebase: { value: "1", timescale: "1000" }, capability: "transcription-plus-vad", words: [{ text: "hello", start: 1, end: 2, confidence: 0.9 }], vadSegments: [{ kind: "speech", start: 1, end: 2 }] },
};
const context = { kind: "speech" as const, source, provider, revision, range };

async function fixture(record = understanding) {
  const index = new InMemorySemanticMediaIndexStore();
  await index.save(record);
  return { index, artifacts: new InMemoryAnalysisArtifactStore() };
}

test("pin and verify an existing stored analysis without changing the index", async () => {
  const { index, artifacts } = await fixture();
  const before = await index.list();
  const ref = await pinAnalysisEvidence(index, artifacts, context);
  assert.deepEqual(await index.list(), before);
  assert.deepEqual(await verifyAnalysisEvidence(artifacts, ref, context), { status: "verified" });
  assert.deepEqual(await pinAnalysisEvidence(index, artifacts, context), ref);
});

test("missing, stale, partial and conflicting analysis fail closed", async () => {
  const { index, artifacts } = await fixture();
  const ref = await pinAnalysisEvidence(index, artifacts, context);
  for (const changed of [
    { source: { ...source, sourceDigest: "sha256:other" } },
    { provider: { ...provider, configurationDigest: "sha256:other" } },
    { revision: { ...revision, sequence: 2 } },
    { range: { start: 1, end: 11 } },
  ]) assert.notEqual((await verifyAnalysisEvidence(artifacts, ref, { ...context, ...changed })).status, "verified");
  const missing = new InMemoryAnalysisArtifactStore();
  assert.equal((await verifyAnalysisEvidence(missing, ref, context)).status, "unavailable");
  const partial = await fixture({ ...understanding, speech: { ...understanding.speech!, observedRange: { start: 0, end: 2 } } });
  await assert.rejects(() => pinAnalysisEvidence(partial.index, partial.artifacts, context), /ANALYSIS_/);
  const conflict = await fixture({ ...understanding, speech: { ...understanding.speech!, provider: { ...provider, model: "other" } } });
  await assert.rejects(() => pinAnalysisEvidence(conflict.index, conflict.artifacts, context), /ANALYSIS_/);
});

test("changed stored artifact bytes cannot pass the approved reference", async () => {
  const { index, artifacts } = await fixture();
  const ref = await pinAnalysisEvidence(index, artifacts, context);
  const tampered = { get: async () => Buffer.from('{"tampered":true}'), put: async () => {} };
  assert.equal((await verifyAnalysisEvidence(tampered, ref, context)).status, "invalid");
});

test("VAD requires complete available segments and audio requires measured source evidence", async () => {
  const { index, artifacts } = await fixture();
  const vadContext = { ...context, kind: "vad" as const };
  const ref = await pinAnalysisEvidence(index, artifacts, vadContext);
  assert.equal((await verifyAnalysisEvidence(artifacts, ref, vadContext)).status, "verified");
  const noVad = await fixture({ ...understanding, speech: { ...understanding.speech!, capability: "transcription-only", vadSegments: undefined } });
  await assert.rejects(() => pinAnalysisEvidence(noVad.index, noVad.artifacts, vadContext), /ANALYSIS_/);
  const audio = { mediaId: source.mediaId, sourceIdentity: source, provider, revision, requestedRange: { start: 0, end: 10 }, measuredRange: { start: 0, end: 10 }, integratedLufs: -20, truePeakDb: -2, silenceMs: 10, valid: true };
  const audioRecord: MediaUnderstanding = { ...understanding, audio, analysis: [{ capability: "audio", status: "analyzed", provenance: { source, analyzer: provider, ranges: [{ start: 0, end: 10 }] } }] };
  const audioFixture = await fixture(audioRecord);
  const audioContext = { ...context, kind: "audio" as const };
  const audioRef = await pinAnalysisEvidence(audioFixture.index, audioFixture.artifacts, audioContext);
  assert.equal((await verifyAnalysisEvidence(audioFixture.artifacts, audioRef, audioContext)).status, "verified");
  const invalid = await fixture({ ...audioRecord, audio: { ...audio, valid: false } });
  await assert.rejects(() => pinAnalysisEvidence(invalid.index, invalid.artifacts, audioContext), /ANALYSIS_/);
});

test("exact timing changes and contradictory rational ranges are rejected", async () => {
  const { index, artifacts } = await fixture();
  const ref = await pinAnalysisEvidence(index, artifacts, context);
  const altered = { ...context, range: { ...range, startTime: { value: "1", timescale: "1" } } };
  assert.notEqual((await verifyAnalysisEvidence(artifacts, ref, altered)).status, "verified");
  await assert.rejects(() => pinAnalysisEvidence(index, artifacts, { ...context, range: { ...range, startTime: { value: "2", timescale: "1" } } }), /ANALYSIS_/);
});
