import assert from "node:assert/strict";
import { test } from "node:test";
import { rankNarrativeCuts } from "../../../packages/runtime/src/planning/narrative-cuts.js";

const revision = { id: "rev-1", sequence: 1, timestamp: "2026-01-01T00:00:00.000Z" };
const source = { mediaId: "source", source: "source.mov", sourceDigest: "sha256:source", duration: 10 };
const input = {
  source, revision, projectId: "project-1", timelineId: "sequence-1", occurrenceId: "clip-1", sourceRange: { start: 0, end: 10, startTime: { value: "0", timescale: "1" }, durationTime: { value: "10", timescale: "1" } }, sequenceRange: { start: 20, end: 30, startTime: { value: "20", timescale: "1" }, durationTime: { value: "10", timescale: "1" } },
  sequenceFrameDuration: { value: "1", timescale: "10" },
  analysis: {
    schemaVersion: 1 as const, mediaId: source.mediaId, sourceIdentity: source, revision,
    requestedRange: { start: 0, end: 10 }, observedRange: { start: 0, end: 10 },
    provider: { id: "speech", provider: "fixture", version: "1" }, sourceTimebase: { value: "1", timescale: "1000" },
    capability: "transcription-plus-vad" as const,
    words: [{ text: "Complete.", start: 0, end: 1, confidence: 0.99 }, { text: "Next", start: 3, end: 4, confidence: 0.99 }],
    vadSegments: [{ kind: "speech" as const, start: 0, end: 1 }, { kind: "silence" as const, start: 1, end: 3 }, { kind: "speech" as const, start: 3, end: 4 }],
  },
};

test("ranks a review-only pause between complete thoughts with source and sequence evidence", () => {
  const before = structuredClone(input);
  const result = rankNarrativeCuts(input);
  assert.deepEqual(input, before);
  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0]!;
  assert.ok(candidate.sourceRange.start >= 1.2 && candidate.sourceRange.end <= 2.8);
  assert.ok(candidate.sequenceRange.start >= 21.2 && candidate.sequenceRange.end <= 22.8);
  assert.ok(candidate.sequenceRange.startTime && candidate.sequenceRange.durationTime);
  assert.equal(candidate.occurrenceId, "clip-1");
  assert.equal(candidate.reviewRequired, true);
  assert.ok(candidate.rationale);
  assert.ok(candidate.evidence.length > 0);
  assert.deepEqual(result.revision, revision);
  assert.equal(result.projectId, "project-1");
  assert.equal(result.timelineId, "sequence-1");
});

test("does not recommend ambiguous speech, protected content or unobserved silence", () => {
  const protectedInput = { ...input, analysis: { ...input.analysis, protectedSegments: [{ kind: "speech" as const, start: 1.5, end: 2 }] } };
  assert.equal(rankNarrativeCuts(protectedInput).candidates.length, 0);
  const incomplete = { ...input, analysis: { ...input.analysis, observedRange: { start: 0, end: 2 } } };
  assert.equal(rankNarrativeCuts(incomplete).candidates.length, 0);
  const midThought = { ...input, analysis: { ...input.analysis, words: [{ ...input.analysis.words[0]!, text: "Incomplete" }, input.analysis.words[1]!] } };
  assert.equal(rankNarrativeCuts(midThought).candidates.length, 0);
  const noVad = { ...input, analysis: { ...input.analysis, vadSegments: undefined } };
  assert.equal(rankNarrativeCuts(noVad).candidates.length, 0);
});

test("visual gaps alone never authorize a cut, and stale or retimed mappings fail", () => {
  const visualOnly = { ...input, analysis: { ...input.analysis, vadSegments: undefined }, visualGaps: [{ start: 1, end: 3 }] };
  assert.equal(rankNarrativeCuts(visualOnly).candidates.length, 0);
  assert.throws(() => rankNarrativeCuts({ ...input, revision: { ...revision, sequence: 2 } }), /STALE/);
  assert.throws(() => rankNarrativeCuts({ ...input, sequenceRange: { start: 20, end: 25 } }), /AMBIGUOUS/);
});


test("rejects low-confidence or overlapping words, VAD contradictions and stale source", () => {
  const low = { ...input, analysis: { ...input.analysis, words: [{ ...input.analysis.words[0]!, confidence: 0.1 }, input.analysis.words[1]!] } };
  assert.equal(rankNarrativeCuts(low).candidates.length, 0);
  const overlap = { ...input, analysis: { ...input.analysis, vadSegments: [...input.analysis.vadSegments, { kind: "speech" as const, start: 1.5, end: 2 }] } };
  assert.equal(rankNarrativeCuts(overlap).candidates.length, 0);
  assert.throws(() => rankNarrativeCuts({ ...input, source: { ...source, sourceDigest: "sha256:changed" } }), /SOURCE|TARGET/);
});

test("requires exact timeline identity and reports unavailable evidence", () => {
  assert.throws(() => rankNarrativeCuts({ ...input, sequenceRange: { start: 20, end: 30 } }), /AMBIGUOUS|ANALYSIS/);
  const result = rankNarrativeCuts({ ...input, analysis: { ...input.analysis, vadSegments: undefined } });
  assert.ok(result.warnings.length > 0);
});

test("preserves exact source and sequence timing for fractional frame candidates", () => {
  const result = rankNarrativeCuts({ ...input, sequenceRange: { start: 0, end: 10, startTime: { value: "0", timescale: "1" }, durationTime: { value: "10", timescale: "1" } }, sequenceFrameDuration: { value: "1001", timescale: "24000" } });
  assert.equal(result.candidates.length, 1);
  const cut = result.candidates[0]!;
  assert.ok(cut.sourceRange.startTime && cut.sourceRange.durationTime);
  assert.ok(cut.sequenceRange.startTime && cut.sequenceRange.durationTime);
  const seconds = (time: { value: string; timescale: string }) => Number(time.value) / Number(time.timescale);
  assert.ok(Math.abs(seconds(cut.sourceRange.startTime) - cut.sourceRange.start) < 1e-9);
  assert.ok(Math.abs(seconds(cut.sequenceRange.startTime) - cut.sequenceRange.start) < 1e-9);
  assert.ok(Math.abs(seconds(cut.sourceRange.durationTime) - (cut.sourceRange.end - cut.sourceRange.start)) < 1e-9);
});


test("requires exact project and timeline identities", () => {
  assert.throws(() => rankNarrativeCuts({ ...input, projectId: "" }), /TARGET/);
  assert.throws(() => rankNarrativeCuts({ ...input, timelineId: "" }), /TARGET/);
});
