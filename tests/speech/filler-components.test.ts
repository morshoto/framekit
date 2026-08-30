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

function resolverRequest(overrides: Partial<Parameters<SafeCutResolver["resolve"]>[0]> = {}) {
  const candidate = detect()[0]!;
  const analysis = {
    ...analysisWithVAD,
    words: analysisWithVAD.words.map((word) => ({ ...word })),
  } as SpeechAnalysis;
  return {
    candidate,
    analysis,
    targetRange: { start: 10, end: 13 },
    occurrence: {
      occurrenceId: "occurrence-1",
      sourceRange: { start: 5, end: 8 },
      sequenceRange: { start: 10, end: 13 },
    },
    timelineId: "timeline-1",
    sequenceFrameDuration: { value: "1", timescale: "30" },
    ...overrides,
  };
}

const analysisWithVAD = {
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
};

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
    end: 11.1,
    startTime: { value: "52", timescale: "5" },
    durationTime: { value: "7", timescale: "10" },
  });
  assert.deepEqual(decision.operation, {
    type: "ripple-delete",
    timelineId: "timeline-1",
    range: decision.range,
    reason: `remove filler candidate ${candidate.id}`,
  });
});

test("resolver suggests but never auto-applies a low-confidence candidate", () => {
  const request = resolverRequest();
  request.candidate = {
    ...request.candidate,
    confidence: 0.5,
    confidenceThreshold: 0.9,
    eligible: false,
  };

  const decision = new SafeCutResolver().resolve(request);

  assert.equal(decision.status, "SUGGESTED");
  assert.ok(decision.reasonCodes.includes("LOW_CONFIDENCE"));
  assert.equal(decision.operation?.type, "ripple-delete");
});

test("resolver skips a candidate when VAD evidence is missing", () => {
  const request = resolverRequest({ analysis: { words: analysisWithVAD.words } });

  const decision = new SafeCutResolver().resolve(request);

  assert.equal(decision.status, "SKIPPED");
  assert.deepEqual(decision.reasonCodes, ["MISSING_VAD_EVIDENCE"]);
  assert.equal(decision.operation, undefined);
});

test("resolver skips ambiguous source-to-sequence mappings", () => {
  const request = resolverRequest({
    candidate: {
      ...detect()[0]!,
      sequenceRange: { start: 10.5, end: 10.8 },
    },
  });

  const decision = new SafeCutResolver().resolve(request);

  assert.equal(decision.status, "SKIPPED");
  assert.deepEqual(decision.reasonCodes, ["AMBIGUOUS_MAPPING"]);
});

test("resolver skips overlapping speech and protected segments", () => {
  const overlapping = resolverRequest({
    analysis: {
      ...analysisWithVAD,
      vadSegments: [
        { start: 5, end: 5.5, kind: "speech" },
        { start: 5.4, end: 6.6, kind: "speech" },
      ],
    } as SpeechAnalysis,
  });
  const overlapDecision = new SafeCutResolver().resolve(overlapping);
  assert.equal(overlapDecision.status, "SKIPPED");
  assert.deepEqual(overlapDecision.reasonCodes, ["OVERLAPPING_SPEECH"]);

  const protectedRequest = resolverRequest({
    analysis: {
      ...analysisWithVAD,
      protectedSegments: [{ start: 5.5, end: 5.8, kind: "breath" }],
    } as SpeechAnalysis,
  });
  const protectedDecision = new SafeCutResolver().resolve(protectedRequest);
  assert.equal(protectedDecision.status, "SKIPPED");
  assert.deepEqual(protectedDecision.reasonCodes, ["PROTECTED_SEGMENT_OVERLAP"]);
});

test("resolver keeps every range inside target and occurrence bounds", () => {
  const outsideTarget = new SafeCutResolver().resolve(resolverRequest({
    targetRange: { start: 10.5, end: 13 },
  }));
  assert.equal(outsideTarget.status, "SKIPPED");
  assert.deepEqual(outsideTarget.reasonCodes, ["OUTSIDE_TARGET_BOUND"]);

  const outsideOccurrence = new SafeCutResolver().resolve(resolverRequest({
    occurrence: {
      occurrenceId: "occurrence-1",
      sourceRange: { start: 5, end: 8 },
      sequenceRange: { start: 10.5, end: 13.5 },
    },
  }));
  assert.equal(outsideOccurrence.status, "SKIPPED");
  assert.deepEqual(outsideOccurrence.reasonCodes, ["OUTSIDE_OCCURRENCE_BOUND"]);
});

test("resolver skips a range that cannot retain frame-safe boundaries", () => {
  const detector = new FillerDetector({ vocabulary: ["um"] });
  const request = {
    candidate: detector.detect({
      previewId: "preview-frame",
      analysis: {
        words: [{ text: "um", start: 5.405, end: 5.415, confidence: 0.99, filler: true }],
      },
      targetRange: { start: 10.405, end: 10.415 },
      occurrence: {
        occurrenceId: "occurrence-frame",
        sourceRange: { start: 5.405, end: 8.405 },
        sequenceRange: { start: 10.405, end: 13.405 },
      },
    })[0]!,
    analysis: {
      words: [{ text: "um", start: 5.405, end: 5.415, confidence: 0.99, filler: true }],
      vadSegments: [{ start: 5.405, end: 5.415, kind: "speech" }],
    } as SpeechAnalysis,
    targetRange: { start: 10.405, end: 10.415 },
    occurrence: {
      occurrenceId: "occurrence-frame",
      sourceRange: { start: 5.405, end: 8.405 },
      sequenceRange: { start: 10.405, end: 13.405 },
    },
    timelineId: "timeline-frame",
    sequenceFrameDuration: { value: "1", timescale: "30" },
  };

  const decision = new SafeCutResolver().resolve(request);

  assert.equal(decision.status, "SKIPPED");
  assert.deepEqual(decision.reasonCodes, ["NO_FRAME_ALIGNED_RANGE"]);
});
