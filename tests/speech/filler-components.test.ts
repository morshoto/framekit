import assert from "node:assert/strict";
import test from "node:test";
import {
  FillerDetector,
  SafeCutResolver,
  type AnalysisInput,
  type SpeechAnalysis,
} from "@framekit/runtime";
import { FixtureSpeechAnalyzer } from "@framekit/testkit";

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

test("candidate IDs stay stable when an analysis window adds unrelated words", () => {
  const detector = new FillerDetector({ vocabulary: ["um", "uh"], confidenceThreshold: 0.9 });
  const occurrence = {
    occurrenceId: "occurrence-window",
    sourceRange: { start: 5, end: 8 },
    sequenceRange: { start: 10, end: 13 },
  };
  const original = detector.detect({
    previewId: "preview-window",
    analysis,
    targetRange: { start: 10, end: 13 },
    occurrence,
  })[0]!;
  const expanded = detector.detect({
    previewId: "preview-window",
    analysis: {
      words: [{ text: "intro", start: 4, end: 4.2, confidence: 0.99 }, ...analysis.words],
    },
    targetRange: { start: 10, end: 13 },
    occurrence,
  })[0]!;

  assert.equal(expanded.id, original.id);
});

test("detector records vocabulary-only and low-confidence evidence", () => {
  const detector = new FillerDetector({ vocabulary: ["uh"], confidenceThreshold: 0.9 });
  const candidates = detector.detect({
    previewId: "preview-policy",
    analysis: {
      words: [{ text: "uh", start: 5.4, end: 5.7, confidence: 0.5 }],
    },
    targetRange: { start: 10, end: 13 },
    occurrence: {
      occurrenceId: "occurrence-policy",
      sourceRange: { start: 5, end: 8 },
      sequenceRange: { start: 10, end: 13 },
    },
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.evidence.analyzerMarkedFiller, false);
  assert.equal(candidates[0]?.evidence.vocabularyMatch, true);
  assert.equal(candidates[0]?.eligible, false);
  assert.deepEqual(candidates[0]?.reasonCodes, ["VOCABULARY_MATCH", "BELOW_CONFIDENCE_THRESHOLD"]);
});

test("detector normalizes repeated trailing punctuation", () => {
  const candidates = new FillerDetector({ vocabulary: ["uh"] }).detect({
    previewId: "preview-punctuation",
    analysis: {
      words: [{ text: "uh!!!", start: 5.4, end: 5.7, confidence: 0.99 }],
    },
    targetRange: { start: 10, end: 13 },
    occurrence: {
      occurrenceId: "occurrence-punctuation",
      sourceRange: { start: 5, end: 8 },
      sequenceRange: { start: 10, end: 13 },
    },
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.evidence.vocabularyMatch, true);
});

test("fixture speech analysis preserves range-bound VAD and protected evidence", async () => {
  const input = {
    project: {} as AnalysisInput["project"],
    media: {
      mediaId: "fixture-media",
      source: "fixture.wav",
      speech: {
        words: [{ text: "um", start: 0.3, end: 0.5, confidence: 0.99, filler: true }],
        vadSegments: [
          { start: 0, end: 0.2, kind: "speech" },
          { start: 0.2, end: 0.6, kind: "speech" },
          { start: 0.6, end: 0.8, kind: "silence" },
        ],
        silenceSegments: [{ start: 0.6, end: 0.8, kind: "silence" }],
        protectedSegments: [{ start: 0.6, end: 0.7, kind: "breath" }],
      },
    },
  } as AnalysisInput;

  const result = await new FixtureSpeechAnalyzer().analyze(input, { start: 0.25, end: 0.75 });

  assert.deepEqual(result.vadSegments, [
    { start: 0.2, end: 0.6, kind: "speech" },
    { start: 0.6, end: 0.8, kind: "silence" },
  ]);
  assert.deepEqual(result.silenceSegments, [{ start: 0.6, end: 0.8, kind: "silence" }]);
  assert.deepEqual(result.protectedSegments, [{ start: 0.6, end: 0.7, kind: "breath" }]);
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

  const protectedPauseRequest = resolverRequest({
    analysis: {
      ...analysisWithVAD,
      protectedSegments: [{ start: 5.95, end: 6.15, kind: "laughter" }],
    } as SpeechAnalysis,
  });
  const protectedPauseDecision = new SafeCutResolver().resolve(protectedPauseRequest);
  assert.equal(protectedPauseDecision.status, "SKIPPED");
  assert.deepEqual(protectedPauseDecision.reasonCodes, ["PROTECTED_SEGMENT_OVERLAP"]);
});

test("resolver distinguishes malformed VAD evidence from missing VAD", () => {
  const decision = new SafeCutResolver().resolve(resolverRequest({
    analysis: {
      ...analysisWithVAD,
      vadSegments: [{ start: 5.4, end: 5.3, kind: "speech" }],
    } as SpeechAnalysis,
  }));

  assert.equal(decision.status, "SKIPPED");
  assert.deepEqual(decision.reasonCodes, ["INVALID_VAD_EVIDENCE"]);
});

test("resolver identifies malformed silence and protected evidence", () => {
  const malformedSilence = new SafeCutResolver().resolve(resolverRequest({
    analysis: {
      ...analysisWithVAD,
      silenceSegments: [{ start: 5.7, end: 5.6, kind: "silence" }],
    } as SpeechAnalysis,
  }));
  assert.equal(malformedSilence.status, "SKIPPED");
  assert.deepEqual(malformedSilence.reasonCodes, ["INVALID_SILENCE_EVIDENCE"]);

  const malformedProtected = new SafeCutResolver().resolve(resolverRequest({
    analysis: {
      ...analysisWithVAD,
      protectedSegments: [{ start: 6.2, end: 6.1, kind: "breath" }],
    } as SpeechAnalysis,
  }));
  assert.equal(malformedProtected.status, "SKIPPED");
  assert.deepEqual(malformedProtected.reasonCodes, ["INVALID_PROTECTED_EVIDENCE"]);
});

test("resolver rejects VAD segments that overlap across speech and silence", () => {
  const decision = new SafeCutResolver().resolve(resolverRequest({
    analysis: {
      ...analysisWithVAD,
      vadSegments: [
        { start: 5, end: 5.3, kind: "speech" },
        { start: 5.3, end: 5.4, kind: "silence" },
        { start: 5.4, end: 6, kind: "speech" },
        { start: 5.7, end: 6.6, kind: "silence" },
        { start: 6.6, end: 6.9, kind: "speech" },
      ],
    } as SpeechAnalysis,
  }));

  assert.equal(decision.status, "SKIPPED");
  assert.deepEqual(decision.reasonCodes, ["INVALID_VAD_EVIDENCE"]);
});

test("resolver protects segments touched by outward frame alignment", () => {
  const decision = new SafeCutResolver().resolve(resolverRequest({
    analysis: {
      ...analysisWithVAD,
      protectedSegments: [{ start: 6.11, end: 6.12, kind: "laughter" }],
    } as SpeechAnalysis,
    sequenceFrameDuration: { value: "1", timescale: "24" },
  }));

  assert.equal(decision.status, "SKIPPED");
  assert.deepEqual(decision.reasonCodes, ["PROTECTED_SEGMENT_OVERLAP"]);
});

test("resolver keeps multiple resolved candidates deterministic and non-overlapping", () => {
  const detector = new FillerDetector({ vocabulary: ["um", "uh"] });
  const words = [
    { text: "So", start: 0, end: 0.3, confidence: 0.99 },
    { text: "um", start: 0.4, end: 0.7, confidence: 0.99, filler: true },
    { text: "we", start: 0.8, end: 1.1, confidence: 0.99 },
    { text: "uh", start: 1.2, end: 1.4, confidence: 0.99, filler: true },
    { text: "go", start: 1.5, end: 1.8, confidence: 0.99 },
  ];
  const occurrence = {
    occurrenceId: "occurrence-many",
    sourceRange: { start: 0, end: 2 },
    sequenceRange: { start: 20, end: 22 },
  };
  const analysisWithSegments = {
    words,
    vadSegments: [
      { start: 0, end: 0.3, kind: "speech" },
      { start: 0.3, end: 0.4, kind: "silence" },
      { start: 0.4, end: 0.7, kind: "speech" },
      { start: 0.7, end: 0.8, kind: "silence" },
      { start: 0.8, end: 1.1, kind: "speech" },
      { start: 1.1, end: 1.2, kind: "silence" },
      { start: 1.2, end: 1.4, kind: "speech" },
      { start: 1.4, end: 1.5, kind: "silence" },
      { start: 1.5, end: 1.8, kind: "speech" },
    ],
  } as SpeechAnalysis;
  const candidates = detector.detect({
    previewId: "preview-many",
    analysis: analysisWithSegments,
    targetRange: { start: 20, end: 22 },
    occurrence,
  });
  const resolver = new SafeCutResolver();
  const resolve = () => candidates.map((candidate) => resolver.resolve({
    candidate,
    analysis: analysisWithSegments,
    targetRange: { start: 20, end: 22 },
    occurrence,
    timelineId: "timeline-many",
    sequenceFrameDuration: { value: "1", timescale: "30" },
  }));
  const decisions = resolve();

  assert.deepEqual(decisions, resolve());
  assert.equal(decisions.every((decision) => decision.status === "AUTO_APPLY"), true);
  const ranges = decisions.map((decision) => decision.range!).sort((left, right) => left.start - right.start);
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index]!;
    assert.equal(range.start >= 20 && range.end <= 22, true);
    assert.equal(range.end > range.start, true);
    assert.equal(Math.abs(range.start * 30 - Math.round(range.start * 30)) < 0.000001, true);
    assert.equal(Math.abs(range.end * 30 - Math.round(range.end * 30)) < 0.000001, true);
    assert.equal(index === 0 || ranges[index - 1]!.end <= range.start, true);
  }
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

test("resolver aligns non-integral word bounds inside surrounding silence", () => {
  const detector = new FillerDetector({ vocabulary: ["um"] });
  const words = [
    { text: "So", start: 5, end: 5.3, confidence: 0.99 },
    { text: "um", start: 5.405, end: 5.615, confidence: 0.99, filler: true },
    { text: "okay", start: 6, end: 6.3, confidence: 0.99 },
  ];
  const occurrence = {
    occurrenceId: "occurrence-non-integral",
    sourceRange: { start: 5, end: 8 },
    sequenceRange: { start: 10, end: 13 },
  };
  const candidate = detector.detect({
    previewId: "preview-non-integral",
    analysis: { words },
    targetRange: { start: 10, end: 13 },
    occurrence,
  })[0]!;

  const decision = new SafeCutResolver().resolve({
    candidate,
    analysis: {
      words,
      vadSegments: [
        { start: 5, end: 5.3, kind: "speech" },
        { start: 5.3, end: 5.405, kind: "silence" },
        { start: 5.405, end: 5.615, kind: "speech" },
        { start: 5.615, end: 6, kind: "silence" },
        { start: 6, end: 6.3, kind: "speech" },
      ],
    } as SpeechAnalysis,
    targetRange: { start: 10, end: 13 },
    occurrence,
    timelineId: "timeline-non-integral",
    sequenceFrameDuration: { value: "1", timescale: "30" },
  });

  assert.equal(decision.status, "AUTO_APPLY");
  assert.deepEqual(decision.range, {
    start: 10.4,
    end: 319 / 30,
    startTime: { value: "52", timescale: "5" },
    durationTime: { value: "7", timescale: "30" },
  });
});

test("resolver skips cuts that would clip untranscribed speech", () => {
  const detector = new FillerDetector({ vocabulary: ["um"] });
  const words = [
    { text: "So", start: 5, end: 5.3, confidence: 0.99 },
    { text: "um", start: 5.36, end: 5.6, confidence: 0.99, filler: true },
    { text: "okay", start: 6, end: 6.3, confidence: 0.99 },
  ];
  const occurrence = {
    occurrenceId: "occurrence-untranscribed",
    sourceRange: { start: 5, end: 8 },
    sequenceRange: { start: 10, end: 13 },
  };
  const candidate = detector.detect({
    previewId: "preview-untranscribed",
    analysis: { words },
    targetRange: { start: 10, end: 13 },
    occurrence,
  })[0]!;
  const decision = new SafeCutResolver().resolve({
    candidate,
    analysis: {
      words,
      vadSegments: [
        { start: 5, end: 5.35, kind: "speech" },
        { start: 5.35, end: 5.36, kind: "silence" },
        { start: 5.36, end: 5.6, kind: "speech" },
        { start: 5.6, end: 6, kind: "silence" },
        { start: 6, end: 6.3, kind: "speech" },
      ],
    } as SpeechAnalysis,
    targetRange: { start: 10, end: 13 },
    occurrence,
    timelineId: "timeline-untranscribed",
    sequenceFrameDuration: { value: "1", timescale: "30" },
  });

  assert.equal(decision.status, "SKIPPED");
  assert.deepEqual(decision.reasonCodes, ["NO_FRAME_ALIGNED_RANGE"]);
});
