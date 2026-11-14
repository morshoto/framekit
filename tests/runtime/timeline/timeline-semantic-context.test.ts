import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentVideoRuntime,
  InMemorySemanticMediaIndexStore,
  type MediaUnderstanding,
} from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";

const sourceIdentity = {
  mediaId: "media-interview",
  source: "/fixtures/interview.mov",
  sourceDigest: "sha256:interview",
  mediaKind: "video" as const,
  duration: 20,
};

function understanding(): MediaUnderstanding {
  return {
    mediaId: sourceIdentity.mediaId,
    source: sourceIdentity.source,
    sourceIdentity,
    metadata: {
      usableRanges: [{ start: 0, end: 20 }],
    },
    speech: {
      words: [
        { text: "first", start: 1, end: 2, confidence: 0.9 },
        { text: "second", start: 11, end: 12, confidence: 0.8 },
      ],
    },
    visual: {
      scenes: [{ id: "scene-crossing", start: 4, end: 12, label: "interview", confidence: 0.7 }],
      subjects: [{ id: "subject-second", label: "person", confidence: 0.95, start: 10, end: 15 }],
      keyframes: [],
    },
    semantic: {
      subjects: [{ value: "person", confidence: 0.95 }],
      scenes: [{ value: "interview", confidence: 0.7 }],
      environments: [],
      timeOfDay: [],
      moods: [],
      usableRanges: [{ start: 0, end: 20 }],
    },
    analysis: [
      {
        capability: "speech",
        status: "analyzed",
        provenance: {
          analyzer: { id: "fixture.speech", provider: "fixture", version: "1" },
          source: sourceIdentity,
          ranges: [{ start: 0, end: 20 }],
        },
      },
      {
        capability: "visual",
        status: "analyzed",
        provenance: {
          analyzer: { id: "fixture.visual", provider: "fixture", version: "1" },
          source: sourceIdentity,
          ranges: [{ start: 0, end: 20 }],
        },
      },
    ],
    analysisRevision: { id: "analysis-rev", sequence: 1, timestamp: new Date(1).toISOString() },
  };
}

function adapterFor(mediaDigest = sourceIdentity.sourceDigest) {
  return new InMemoryEditorAdapter({
    projectId: "project-semantic-context",
    projectName: "Semantic Context Fixture",
    timelineId: "timeline-semantic-context",
    timelineName: "Main",
    clips: [
      {
        id: "occurrence-first",
        mediaId: sourceIdentity.mediaId,
        name: "First excerpt",
        start: 0,
        duration: 5,
        sourceStart: 0,
        sourceStartTime: { value: "0", timescale: "1" },
        track: 1,
      },
      {
        id: "occurrence-second",
        mediaId: sourceIdentity.mediaId,
        name: "Second excerpt",
        start: 5,
        duration: 5,
        sourceStart: 10,
        sourceStartTime: { value: "10", timescale: "1" },
        track: 1,
      },
      {
        id: "occurrence-missing",
        mediaId: "media-missing",
        name: "Missing source",
        start: 10,
        duration: 2,
        track: 1,
      },
    ],
    media: [{
      mediaId: sourceIdentity.mediaId,
      source: sourceIdentity.source,
      sourceDigest: mediaDigest,
      mediaKind: "video",
      duration: sourceIdentity.duration,
    }],
  });
}

test("timeline semantic context clips repeated source occurrences to exact ranges", async () => {
  const store = new InMemorySemanticMediaIndexStore();
  await store.save(understanding());
  const runtime = new AgentVideoRuntime(adapterFor(), { semanticMediaIndexStore: store });

  const context = await runtime.inspectTimelineSemanticContext();
  assert.deepEqual(context.occurrences.map((occurrence) => ({ id: occurrence.occurrenceId, status: occurrence.status })), [
    { id: "occurrence-first", status: "available" },
    { id: "occurrence-second", status: "available" },
    { id: "occurrence-missing", status: "unavailable" },
  ]);

  const first = context.occurrences[0]!;
  assert.deepEqual(first.sourceRange, {
    start: 0,
    end: 5,
    startTime: { value: "0", timescale: "1" },
    durationTime: { value: "5", timescale: "1" },
  });
  assert.deepEqual(first.observations.map((observation) => ({
    capability: observation.capability,
    text: observation.text,
    label: observation.label,
    range: observation.range,
  })), [
    { capability: "metadata", text: undefined, label: undefined, range: { start: 0, end: 5 } },
    { capability: "speech", text: "first", label: undefined, range: { start: 1, end: 2 } },
    { capability: "visual", text: undefined, label: "interview", range: { start: 4, end: 5 } },
  ]);
  assert.equal(first.observations.some((observation) => observation.text === "second"), false);

  const second = context.occurrences[1]!;
  assert.deepEqual(second.observations.filter((observation) => observation.text === "second")[0]?.range, { start: 11, end: 12 });
  assert.deepEqual(second.observations.filter((observation) => observation.label === "interview")[0]?.range, { start: 10, end: 12 });
  assert.deepEqual(second.observations.filter((observation) => observation.label === "person")[0]?.range, { start: 10, end: 15 });
  assert.equal(second.analysis[0]?.provenance?.analyzer.version, "1");
  assert.equal(context.revision.id, "rev-0");
});

test("timeline semantic search and source-digest mismatch remain explicit", async () => {
  const store = new InMemorySemanticMediaIndexStore();
  await store.save(understanding());
  const runtime = new AgentVideoRuntime(adapterFor(), { semanticMediaIndexStore: store });

  const matching = await runtime.inspectTimelineSemanticContext({ query: "second" });
  assert.deepEqual(matching.occurrences.map((occurrence) => occurrence.occurrenceId), ["occurrence-second"]);

  const mismatched = new AgentVideoRuntime(adapterFor("sha256:changed"), { semanticMediaIndexStore: store });
  const unavailable = await mismatched.inspectTimelineSemanticContext({ occurrenceIds: ["occurrence-first"] });
  assert.equal(unavailable.occurrences[0]?.status, "unavailable");
  assert.match(unavailable.occurrences[0]?.reason ?? "", /source-bound semantic index entry is unavailable/);
});
