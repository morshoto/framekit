import assert from "node:assert/strict";
import test from "node:test";
import {
  FillerDetector,
  SafeCutResolver,
  type SpeechAnalysis,
} from "@framekit/runtime";

const analysis: SpeechAnalysis = {
  words: [
    { text: "So", start: 5, end: 5.3, confidence: 0.99 },
    { text: "um", start: 5.4, end: 5.7, confidence: 0.98, filler: true },
    { text: "like", start: 6, end: 6.2, confidence: 0.96 },
    { text: "okay", start: 6.5, end: 6.9, confidence: 0.99 },
  ],
};

function detect(previewId = "preview-1") {
  return new FillerDetector({ vocabulary: ["um", "uh"], confidenceThreshold: 0.9 }).detect({
    previewId,
    analysis,
    targetRange: { start: 10, end: 13 },
    occurrence: {
      occurrenceId: "occurrence-1",
      mediaId: "media-1",
      sourceRange: { start: 5, end: 8 },
      sequenceRange: { start: 10, end: 13 },
    },
  });
}

test("detector creates deterministic candidates from metadata and vocabulary", () => {
  const candidates = detect();

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.word.text, "um");
  assert.equal(candidates[0]?.occurrenceId, "occurrence-1");
  assert.equal(candidates[0]?.confidence, 0.98);
  assert.equal(candidates[0]?.confidenceThreshold, 0.9);
  assert.deepEqual(candidates[0]?.sourceRange, { start: 5.4, end: 5.7 });
  assert.deepEqual(candidates[0]?.sequenceRange, { start: 10.4, end: 10.7 });
  assert.ok(candidates[0]?.reasonCodes.includes("ANALYZER_MARKED_FILLER"));
  assert.ok(candidates[0]?.reasonCodes.includes("VOCABULARY_MATCH"));
  assert.equal(candidates[0]?.eligible, true);
});

test("candidate IDs are stable within a preview and change across previews", () => {
  const first = detect("preview-1");
  const repeat = detect("preview-1");
  const other = detect("preview-2");

  assert.equal(first[0]?.id, repeat[0]?.id);
  assert.notEqual(first[0]?.id, other[0]?.id);
});

test("resolver auto-applies a bounded frame-aligned cut with pause preservation", () => {
  const candidate = detect()[0]!;
  const resolver = new SafeCutResolver({ preservePauseMs: 700, targetPauseMs: 500 });
  const speech = {
    words: [
      { text: "So", start: 5, end: 5.3, confidence: 0.99 },
      { text: "um", start: 5.4, end: 5.7, confidence: 0.98, filler: true },
      { text: "okay", start: 6.6, end: 6.9, confidence: 0.99 },
    ],
    vadSegments: [
      { start: 5, end: 5.3, kind: "speech" },
      { start: 5.3, end: 5.4, kind: "silence" },
      { start: 5.4, end: 5.7, kind: "speech" },
      { start: 5.7, end: 6.6, kind: "silence" },
      { start: 6.6, end: 6.9, kind: "speech" },
    ],
    silenceSegments: [{ start: 5.7, end: 6.6, kind: "silence" }],
  } as SpeechAnalysis;

  const decision = resolver.resolve({
    candidate,
    analysis: speech,
    targetRange: { start: 10, end: 13 },
    occurrence: {
      occurrenceId: "occurrence-1",
      sourceRange: { start: 5, end: 8 },
      sequenceRange: { start: 10, end: 13 },
    },
    timelineId: "timeline-1",
    sequenceFrameDuration: { value: "1", timescale: "30" },
  });

  assert.equal(decision.status, "AUTO_APPLY");
  assert.deepEqual(decision.range, {
    start: 10.4,
    end: 10.9,
    startTime: { value: "52", timescale: "5" },
    durationTime: { value: "1", timescale: "2" },
  });
  assert.deepEqual(decision.operation, {
    type: "ripple-delete",
    timelineId: "timeline-1",
    range: decision.range,
    reason: "remove filler candidate filler-candidate",
  });
});
