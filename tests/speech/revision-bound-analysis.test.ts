import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentVideoRuntime,
  bindSpeechAnalysis,
  type AnalysisInput,
  type AnalyzerDescriptor,
  type MediaSourceIdentity,
  type SpeechAnalysis,
} from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";

const sourceIdentity: MediaSourceIdentity = {
  mediaId: "media-1",
  source: "/media/interview.wav",
  sourceDigest: "sha256:interview",
  mediaKind: "audio",
  duration: 12,
};

const input: AnalysisInput = {
  project: {
    projectId: "project-1",
    projectName: "Speech contract fixture",
    timeline: {
      id: "timeline-1",
      name: "Main",
      duration: 12,
      clips: [],
      storyElements: [],
      markers: [],
      captions: [],
    },
    media: [{ mediaId: sourceIdentity.mediaId, source: sourceIdentity.source, sourceDigest: sourceIdentity.sourceDigest, mediaKind: sourceIdentity.mediaKind, duration: sourceIdentity.duration }],
    revision: { id: "rev-7", sequence: 7, timestamp: "2026-09-10T00:00:00.000Z" },
  },
  media: { ...sourceIdentity },
};

const provider: AnalyzerDescriptor = {
  id: "local.whisper-silero",
  provider: "local-wrapper",
  version: "2.1.0",
};

test("speech binding attaches revision, range, identity, provider, and source timebase", () => {
  const result = bindSpeechAnalysis({
    mediaId: sourceIdentity.mediaId,
    sourceIdentity,
    revision: input.project.revision,
    requestedRange: { start: 2, end: 6 },
    observedRange: { start: 2, end: 6 },
    provider,
    sourceTimebase: { value: "1", timescale: "1000" },
    words: [{ text: "hello", start: 2, end: 2.5, confidence: 0.98 }],
    vadSegments: [{ start: 2, end: 2.5, kind: "speech" }],
  }, { input, provider, range: { start: 2, end: 6 } });

  assert.deepEqual(result, {
    mediaId: sourceIdentity.mediaId,
    sourceIdentity,
    revision: input.project.revision,
    requestedRange: { start: 2, end: 6 },
    observedRange: { start: 2, end: 6 },
    provider,
    sourceTimebase: { value: "1", timescale: "1000" },
    capability: "transcription-plus-vad",
    words: [{ text: "hello", start: 2, end: 2.5, confidence: 0.98 }],
    vadSegments: [{ start: 2, end: 2.5, kind: "speech" }],
  });
});

test("speech binding preserves transcription-only capability without inventing VAD", () => {
  const result = bindSpeechAnalysis({
    words: [{ text: "hello", start: 0, end: 1, confidence: 0.98 }],
  }, { input, provider });

  assert.equal(result.capability, "transcription-only");
  assert.equal(result.vadSegments, undefined);
  assert.deepEqual(result.sourceIdentity, sourceIdentity);
  assert.deepEqual(result.revision, input.project.revision);
  assert.deepEqual(result.requestedRange, { start: 0, end: 12 });
  assert.deepEqual(result.observedRange, { start: 0, end: 12 });
});

test("speech binding fails closed for stale or mismatched provenance", () => {
  const cases: Array<[string, Partial<SpeechAnalysis>]> = [
    ["media identity", { mediaId: "other-media" }],
    ["source identity", { sourceIdentity: { ...sourceIdentity, sourceDigest: "sha256:other" } }],
    ["revision", { revision: { ...input.project.revision, id: "rev-6", sequence: 6 } }],
    ["requested range", { requestedRange: { start: 0, end: 1 } }],
    ["observed range", { observedRange: { start: 0, end: 13 } }],
  ];

  for (const [label, patch] of cases) {
    assert.throws(
      () => bindSpeechAnalysis({
        words: [{ text: "hello", start: 0, end: 1, confidence: 0.98 }],
        ...patch,
      }, { input, provider, range: { start: 2, end: 6 } }),
      /ANALYSIS_INVALID|STALE_CONTEXT|TARGET_MISMATCH/,
      label,
    );
  }
});

test("speech binding rejects unordered, overlapping, and invalid evidence", () => {
  const invalidAnalyses: SpeechAnalysis[] = [
    {
      words: [
        { text: "later", start: 2, end: 3, confidence: 0.9 },
        { text: "earlier", start: 1, end: 2, confidence: 0.9 },
      ],
    },
    {
      words: [
        { text: "one", start: 0, end: 2, confidence: 0.9 },
        { text: "two", start: 1, end: 3, confidence: 0.9 },
      ],
    },
    { words: [{ text: "outside", start: 0, end: 13, confidence: 0.9 }] },
    {
      words: [{ text: "word", start: 0, end: 1, confidence: 0.9 }],
      vadSegments: [
        { start: 0, end: 2, kind: "speech" },
        { start: 1, end: 3, kind: "silence" },
      ],
    },
    {
      words: [{ text: "word", start: 0, end: 1, confidence: 0.9 }],
      vadSegments: [{ start: 0, end: 13, kind: "speech" }],
    },
  ];

  for (const analysis of invalidAnalyses) {
    assert.throws(
      () => bindSpeechAnalysis(analysis, { input, provider }),
      /ANALYSIS_INVALID/,
    );
  }
});

test("runtime binds legacy analyzer output before returning speech analysis", async () => {
  const adapter = new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Runtime speech fixture",
    timelineId: "timeline-1",
    timelineName: "Main",
    clips: [],
    media: [{ ...sourceIdentity }],
  });
  const runtime = new AgentVideoRuntime(adapter, {
    speechAnalyzer: {
      descriptor: provider,
      analyze: async () => ({ words: [{ text: "hello", start: 0, end: 1, confidence: 0.98 }] }),
    },
  });

  const result = await runtime.analyzeSpeech("media-1");

  assert.equal(result.mediaId, "media-1");
  assert.deepEqual(result.sourceIdentity, sourceIdentity);
  assert.deepEqual(result.revision, (await adapter.readProject()).revision);
  assert.deepEqual(result.provider, provider);
  assert.equal(result.capability, "transcription-only");
});

test("runtime forwards and binds requested speech ranges", async () => {
  const adapter = new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Ranged speech fixture",
    timelineId: "timeline-1",
    timelineName: "Main",
    clips: [],
    media: [{ ...sourceIdentity }],
  });
  let receivedRange;
  const runtime = new AgentVideoRuntime(adapter, {
    speechAnalyzer: {
      analyze: async (_input, range) => {
        receivedRange = range;
        return {
          requestedRange: range,
          observedRange: range,
          words: [{ text: "hello", start: 2, end: 2.5, confidence: 0.98 }],
        };
      },
    },
  });

  const result = await runtime.analyzeSpeech("media-1", { start: 2, end: 6 });

  assert.deepEqual(receivedRange, { start: 2, end: 6 });
  assert.deepEqual(result.requestedRange, { start: 2, end: 6 });
});

test("runtime rejects stale revisions returned by a speech provider", async () => {
  const adapter = new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Stale speech fixture",
    timelineId: "timeline-1",
    timelineName: "Main",
    clips: [],
    media: [{ ...sourceIdentity }],
  });
  const runtime = new AgentVideoRuntime(adapter, {
    speechAnalyzer: {
      analyze: async () => ({
        revision: { id: "rev-old", sequence: 1, timestamp: "2026-09-09T00:00:00.000Z" },
        words: [{ text: "hello", start: 0, end: 1, confidence: 0.98 }],
      }),
    },
  });

  await assert.rejects(runtime.analyzeSpeech("media-1"), /STALE_CONTEXT/);
});
