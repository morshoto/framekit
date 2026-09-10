import assert from "node:assert/strict";
import test from "node:test";
import {
  mapSpeechAnalysisToOccurrence,
  type RevisionBoundSpeechAnalysis,
  type SpeechOccurrence,
} from "@framekit/runtime";

const revision = { id: "rev-4", sequence: 4, timestamp: "2026-09-10T00:00:00.000Z" };
const analysis: RevisionBoundSpeechAnalysis = {
  mediaId: "media-1",
  sourceIdentity: { mediaId: "media-1", source: "/media/interview.wav", duration: 60 },
  requestedRange: { start: 0, end: 60 },
  observedRange: { start: 0, end: 60 },
  revision,
  provider: { id: "local.speech", provider: "wrapper", version: "1" },
  sourceTimebase: { value: "1", timescale: "1000" },
  capability: "transcription-plus-vad",
  words: [
    { text: "before", start: 9, end: 9.4, confidence: 0.99 },
    { text: "um", start: 10.25, end: 10.35, confidence: 0.98, filler: true },
    { text: "after", start: 10.7, end: 11.1, confidence: 0.99 },
    { text: "other", start: 20, end: 20.4, confidence: 0.99 },
  ],
  vadSegments: [{ start: 10.25, end: 10.35, kind: "speech" }],
};

function occurrence(sequenceStart: number): SpeechOccurrence {
  return {
    occurrenceId: `occurrence-${sequenceStart}`,
    mediaId: "media-1",
    revision,
    sourceRange: { start: 10, end: 12 },
    sequenceRange: {
      start: sequenceStart,
      end: sequenceStart + 2,
      startTime: { value: String(sequenceStart * 10), timescale: "10" },
      durationTime: { value: "2", timescale: "1" },
    },
  };
}

test("speech mapping translates trimmed source evidence to offset rational sequence ranges", () => {
  const mapped = mapSpeechAnalysisToOccurrence(analysis, occurrence(30), {
    sequenceFrameDuration: { value: "1", timescale: "10" },
  });

  assert.equal(mapped.occurrenceId, "occurrence-30");
  assert.equal(mapped.mediaId, "media-1");
  assert.deepEqual(mapped.words.map(({ word }) => word.text), ["um", "after"]);
  assert.deepEqual(mapped.words[0]?.sequenceRange, {
    start: 30.25,
    end: 30.35,
    startTime: { value: "121", timescale: "4" },
    durationTime: { value: "1", timescale: "10" },
  });
  assert.deepEqual(mapped.words[0]?.frameAlignedRange, {
    start: 30.2,
    end: 30.4,
    startTime: { value: "151", timescale: "5" },
    durationTime: { value: "1", timescale: "5" },
  });
});

test("speech mapping keeps repeated occurrences independent", () => {
  const first = mapSpeechAnalysisToOccurrence(analysis, occurrence(30), {
    sequenceFrameDuration: { value: "1", timescale: "10" },
  });
  const second = mapSpeechAnalysisToOccurrence(analysis, occurrence(100), {
    sequenceFrameDuration: { value: "1", timescale: "10" },
  });

  assert.equal(first.words[0]?.sequenceRange.start, 30.25);
  assert.equal(second.words[0]?.sequenceRange.start, 100.25);
  assert.notEqual(first.words[0]?.frameAlignedRange.startTime.value, second.words[0]?.frameAlignedRange.startTime.value);
});

test("speech mapping fails closed for stale, ambiguous, and unsupported targets", () => {
  const stale = { ...occurrence(30), revision: { ...revision, id: "rev-old", sequence: 3 } };
  const mismatched = { ...occurrence(30), mediaId: "other-media" };
  const unequal = { ...occurrence(30), sequenceRange: { ...occurrence(30).sequenceRange, end: 33 } };
  const missingRational = { ...occurrence(30), sequenceRange: { start: 30, end: 32 } };
  const partialWord = { ...analysis, words: [{ text: "cut", start: 9.9, end: 10.1, confidence: 0.9 }] };

  for (const target of [stale, mismatched, unequal, missingRational]) {
    assert.throws(
      () => mapSpeechAnalysisToOccurrence(analysis, target, { sequenceFrameDuration: { value: "1", timescale: "10" } }),
      /STALE_CONTEXT|TARGET_MISMATCH|AMBIGUOUS_MAPPING|ANALYSIS_INVALID/,
    );
  }
  assert.throws(
    () => mapSpeechAnalysisToOccurrence(partialWord, occurrence(30), { sequenceFrameDuration: { value: "1", timescale: "10" } }),
    /AMBIGUOUS_MAPPING/,
  );
});
