import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import {
  AgentVideoRuntime,
  JsonSemanticMediaIndexStore,
  bindSpeechAnalysis,
  type ProjectSnapshot,
  mapSourceRangeToSequenceRange,
  mapSpeechAnalysisToOccurrence,
  type RevisionBoundSpeechAnalysis,
  type SpeechOccurrence,
} from "@framekit/runtime";

const revision = { id: "rev-4", sequence: 4, timestamp: "2026-09-10T00:00:00.000Z" };
const analysis: RevisionBoundSpeechAnalysis = {
  schemaVersion: 1,
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
  assert.notEqual(first.words[0]?.frameAlignedRange.startTime?.value, second.words[0]?.frameAlignedRange.startTime?.value);
});

test("speech mapping translates exact source ranges for edit planning", () => {
  const mapped = mapSourceRangeToSequenceRange({
    start: 4.2,
    end: 4.9,
    startTime: { value: "21", timescale: "5" },
    durationTime: { value: "7", timescale: "10" },
  }, {
    sourceRange: {
      start: 4,
      end: 7,
      startTime: { value: "4", timescale: "1" },
      durationTime: { value: "3", timescale: "1" },
    },
    sequenceRange: {
      start: 20,
      end: 23,
      startTime: { value: "20", timescale: "1" },
      durationTime: { value: "3", timescale: "1" },
    },
  });

  assert.deepEqual(mapped, {
    start: 20.2,
    end: 20.9,
    startTime: { value: "101", timescale: "5" },
    durationTime: { value: "7", timescale: "10" },
  });
});

test("speech mapping fails closed for stale, ambiguous, and unsupported targets", () => {
  const stale = { ...occurrence(30), revision: { ...revision, id: "rev-old", sequence: 3 } };
  const mismatched = { ...occurrence(30), mediaId: "other-media" };
  const unequal = { ...occurrence(30), sequenceRange: { ...occurrence(30).sequenceRange, end: 33 } };
  const missingRational = { ...occurrence(30), sequenceRange: { start: 30, end: 32 } };
  const mismatchedTimebase = { ...occurrence(30), sourceTimebase: { value: "1", timescale: "30" } };
  const partialWord = { ...analysis, words: [{ text: "cut", start: 9.9, end: 10.1, confidence: 0.9 }] };

  for (const target of [stale, mismatched, unequal, missingRational, mismatchedTimebase]) {
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

test("speech occurrence mapping refuses unobserved source coverage", () => {
  const partial = {
    ...analysis,
    requestedRange: { start: 10, end: 12 },
    observedRange: { start: 10, end: 11 },
    words: [analysis.words[1]!],
  };
  assert.throws(
    () => mapSpeechAnalysisToOccurrence(partial, occurrence(30), {
      sequenceFrameDuration: { value: "1", timescale: "10" },
    }),
    /AMBIGUOUS_MAPPING.*observed/,
  );
});

for (const [label, range] of [
  ["source occurrence start", { start: 10, end: 12, startTime: { value: "100", timescale: "1" } }],
  ["source occurrence duration", { start: 10, end: 12, durationTime: { value: "3", timescale: "1" } }],
  ["source occurrence clock", { start: 10, end: 12, startTime: { value: "10", timescale: "0" } }],
] as const) {
  test(`speech mapping rejects contradictory ${label} timing`, () => {
    const target = { ...occurrence(30), sourceRange: range };
    assert.throws(
      () => mapSpeechAnalysisToOccurrence(analysis, target, { sequenceFrameDuration: { value: "1", timescale: "10" } }),
      /AMBIGUOUS_MAPPING|ANALYSIS_INVALID/,
    );
  });
}

test("source range translation rejects conflicting exact evidence coordinates", () => {
  assert.throws(
    () => mapSourceRangeToSequenceRange({
      start: 10.25, end: 10.35, startTime: { value: "11", timescale: "1" },
    }, occurrence(30)),
    /AMBIGUOUS_MAPPING/,
  );
});

test("speech mapping retains the declared source clock at fractional frame offsets", () => {
  const frame = { value: "1001", timescale: "24000" };
  const seconds = (frames: number) => frames * 1001 / 24000;
  const fractional = {
    ...analysis,
    sourceTimebase: { value: "1", timescale: "24000" },
    words: [{ text: "exact", start: seconds(12), end: seconds(14), confidence: 1 }],
    vadSegments: undefined,
  };
  const mapped = mapSpeechAnalysisToOccurrence(fractional, {
    occurrenceId: "trimmed-fractional", mediaId: "media-1", revision,
    sourceRange: {
      start: seconds(8), end: seconds(24),
      startTime: { value: "8008", timescale: "24000" },
      durationTime: { value: "16016", timescale: "24000" },
    },
    sequenceRange: {
      start: 0, end: seconds(16),
      startTime: { value: "0", timescale: "24000" },
      durationTime: { value: "16016", timescale: "24000" },
    },
  }, { sequenceFrameDuration: frame });
  assert.deepEqual(mapped.words[0]?.sequenceRange.startTime, { value: "1001", timescale: "6000" });
  assert.deepEqual(mapped.words[0]?.sequenceRange.durationTime, { value: "1001", timescale: "12000" });
  assert.deepEqual(mapped.words[0]?.frameAlignedRange.startTime, { value: "1001", timescale: "6000" });
  assert.deepEqual(mapped.words[0]?.frameAlignedRange.durationTime, { value: "1001", timescale: "12000" });
});

test("speech mapping rejects evidence outside its declared source clock", () => {
  assert.throws(() => mapSpeechAnalysisToOccurrence({
    ...analysis,
    sourceTimebase: { value: "1", timescale: "1000" },
    words: [{ text: "off-grid", start: 10.25001, end: 10.35001, confidence: 1 }],
    vadSegments: undefined,
  }, occurrence(30), { sequenceFrameDuration: { value: "1", timescale: "10" } }),
  /AMBIGUOUS_MAPPING.*source clock/);
});


test("cached speech remaps rational trim reorder and split snapshots after restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-rational-speech-matrix-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const frame = { value: "1001", timescale: "24000" };
  const seconds = (frames: number) => frames * 1001 / 24000;
  const exact = (frames: number) => {
    let numerator = BigInt(frames) * 1001n;
    let denominator = 24000n;
    let a = numerator, b = denominator;
    while (b) [a, b] = [b, a % b];
    numerator /= a; denominator /= a;
    return { value: numerator.toString(), timescale: denominator.toString() };
  };
  const source = {
    mediaId: "matrix-source", source: "/fixtures/known-source.mov",
    sourceDigest: "fixture-content-identity", mediaKind: "video" as const, duration: 60,
  };
  // Independently stated source/sequence frame coordinates and expected word starts.
  const stages = [
    { name: "baseline", total: 48, rows: [
      { id: "a", source: 0, length: 24, sequence: 0, word: "first", mapped: 12 },
      { id: "b", source: 240, length: 24, sequence: 24, word: "second", mapped: 36 },
    ] },
    { name: "trimmed", total: 40, rows: [
      { id: "a", source: 8, length: 16, sequence: 0, word: "first", mapped: 4 },
      { id: "b", source: 240, length: 24, sequence: 16, word: "second", mapped: 28 },
    ] },
    { name: "reordered", total: 40, rows: [
      { id: "b", source: 240, length: 24, sequence: 0, word: "second", mapped: 12 },
      { id: "a", source: 8, length: 16, sequence: 24, word: "first", mapped: 28 },
    ] },
    { name: "split", total: 40, rows: [
      { id: "b-left", source: 240, length: 12, sequence: 0, word: undefined, mapped: undefined },
      { id: "b-right", source: 252, length: 12, sequence: 12, word: "second", mapped: 12 },
      { id: "a", source: 8, length: 16, sequence: 24, word: "first", mapped: 28 },
    ] },
  ];
  let current: ProjectSnapshot;
  class SnapshotAdapter extends InMemoryEditorAdapter {
    public override async readProject() { return structuredClone(current); }
  }
  const adapter = new SnapshotAdapter({
    projectId: "matrix-project", projectName: "Matrix",
    timelineId: "matrix-sequence", timelineName: "Main",
    clips: [], media: [source],
  });
  let providerCalls = 0;
  const provider = {
    descriptor: { id: "fixture.matrix-speech", provider: "fixture", version: "1" },
    analyze: async () => {
      providerCalls += 1;
      return {
        sourceTimebase: { value: "1", timescale: "24000" },
        words: [
          { text: "first", start: seconds(12), end: seconds(14), confidence: 1 },
          { text: "second", start: seconds(252), end: seconds(254), confidence: 1 },
        ],
      };
    },
  };
  let previous: RevisionBoundSpeechAnalysis | undefined;
  for (const [index, stage] of stages.entries()) {
    current = {
      projectId: "matrix-project", projectName: "Matrix",
      timeline: {
        id: "matrix-sequence", name: "Main", duration: seconds(stage.total),
        durationTime: exact(stage.total), frameDuration: frame,
        clips: stage.rows.map((row) => ({
          id: row.id, name: row.id, mediaId: source.mediaId, track: 0,
          start: seconds(row.sequence), startTime: exact(row.sequence),
          duration: seconds(row.length), durationTime: exact(row.length),
          sourceStart: seconds(row.source), sourceStartTime: exact(row.source),
        })),
        storyElements: [], markers: [], captions: [],
      },
      media: [source],
      revision: { id: "canonical:" + stage.name, sequence: index, timestamp: new Date(index).toISOString() },
    };
    const before = structuredClone(current);
    // Every stage uses a new runtime and a reopened JSON store, not attached context.
    const runtime = new AgentVideoRuntime(adapter, {
      speechAnalyzer: provider, semanticMediaIndexStore: new JsonSemanticMediaIndexStore(join(directory, "index.json")),
    });
    const understanding = await runtime.understandMedia(source.mediaId);
    assert.equal(providerCalls, 1, stage.name);
    assert.deepEqual(understanding.speech?.revision, current.revision, stage.name);
    const bound = bindSpeechAnalysis(understanding.speech, {
      input: { project: current, media: source }, provider: provider.descriptor,
    });
    for (const [rowIndex, row] of stage.rows.entries()) {
      const clip = current.timeline.clips[rowIndex]!;
      const occurrence: SpeechOccurrence = {
        occurrenceId: clip.id, mediaId: source.mediaId, revision: current.revision,
        sourceTimebase: { value: "1", timescale: "24000" },
        sourceRange: {
          start: seconds(row.source), end: seconds(row.source + row.length),
          startTime: exact(row.source), durationTime: exact(row.length),
        },
        sequenceRange: {
          start: seconds(row.sequence), end: seconds(row.sequence + row.length),
          startTime: exact(row.sequence), durationTime: exact(row.length),
        },
      };
      if (previous) {
        assert.throws(() => mapSpeechAnalysisToOccurrence(previous!, occurrence, { sequenceFrameDuration: frame }), /STALE_CONTEXT/);
      }
      const mapped = mapSpeechAnalysisToOccurrence(bound, occurrence, { sequenceFrameDuration: frame });
      assert.deepEqual(mapped.revision, current.revision);
      assert.deepEqual(mapped.words.map(({ word }) => word.text), row.word ? [row.word] : []);
      if (row.mapped !== undefined) {
        assert.deepEqual(mapped.words[0]?.sequenceRange.startTime, exact(row.mapped), stage.name + "/" + row.id);
        assert.deepEqual(mapped.words[0]?.sequenceRange.durationTime, exact(2));
        assert.deepEqual(mapped.words[0]?.frameAlignedRange.startTime, exact(row.mapped));
        assert.deepEqual(mapped.words[0]?.frameAlignedRange.durationTime, exact(2));
      }
    }
    assert.deepEqual(current, before, "analysis and mapping must not change canonical fixture state");
    previous = bound;
  }
});
