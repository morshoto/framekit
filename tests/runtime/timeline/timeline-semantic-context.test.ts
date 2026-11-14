import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../../apps/mcp-server/src/server.js";
import {
  AgentVideoRuntime,
  InMemorySemanticMediaIndexStore,
  bindSpeechAnalysis,
  type MediaUnderstanding,
  type ProjectSnapshot,
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

test("timeline semantic context uses authoritative rational source coordinates", async () => {
  class RationalSourceAdapter extends InMemoryEditorAdapter {
    public override async readProject() {
      const snapshot = await super.readProject();
      const clip = snapshot.timeline.clips[0]!;
      // The convenience seconds are rounded; the rational source position is exact.
      clip.sourceStart = 10;
      clip.sourceStartTime = { value: "1001", timescale: "100" };
      return snapshot;
    }
  }
  const baseline = await adapterFor().readProject();
  const adapter = new RationalSourceAdapter({
    projectId: baseline.projectId, projectName: baseline.projectName,
    timelineId: baseline.timeline.id, timelineName: baseline.timeline.name,
    clips: baseline.timeline.clips, media: baseline.media,
  });
  const store = new InMemorySemanticMediaIndexStore();
  await store.save(understanding());
  const runtime = new AgentVideoRuntime(adapter, { semanticMediaIndexStore: store });
  const context = await runtime.inspectTimelineSemanticContext({ occurrenceIds: ["occurrence-first"] });
  assert.deepEqual(context.occurrences[0]?.sourceRange, {
    start: 10.01, end: 15.01,
    startTime: { value: "1001", timescale: "100" },
    durationTime: { value: "5", timescale: "1" },
  });
  assert.equal(context.occurrences[0]?.observations.find((entry) => entry.capability === "speech")?.text, "second");
});

test("timeline semantic context rejects cached evidence from a different configured provider", async () => {
  const store = new InMemorySemanticMediaIndexStore();
  await store.save(understanding());
  const runtime = new AgentVideoRuntime(adapterFor(), {
    semanticMediaIndexStore: store,
    speechAnalyzer: {
      descriptor: { id: "fixture.speech", provider: "fixture", version: "changed-version" },
      analyze: async () => { throw new Error("read-only inspection must not run analysis"); },
    },
  });
  const context = await runtime.inspectTimelineSemanticContext({ occurrenceIds: ["occurrence-first"] });
  assert.equal(context.occurrences[0]?.status, "unavailable");
  assert.match(context.occurrences[0]?.reason ?? "", /provenance.*incompatible/);
  assert.deepEqual(context.occurrences[0]?.observations, []);
});

test("MCP speech mapping rejects incomplete and contradictory cached evidence", async (t) => {
  const cases: Array<{
    label: string;
    corrupt: (evidence: MediaUnderstanding, project: ProjectSnapshot) => void;
    reason: RegExp;
  }> = [
    { label: "incomplete observed coverage", corrupt: (evidence) => {
      evidence.speech!.observedRange = { start: 0, end: 2 };
      evidence.speech!.words = [evidence.speech!.words[0]!];
    }, reason: /observed speech range does not cover/ },
    { label: "missing declared clock", corrupt: (evidence) => { delete evidence.speech!.sourceTimebase; }, reason: /declared speech clock/ },
    { label: "conflicting nested source", corrupt: (evidence) => { evidence.speech!.sourceIdentity!.source = "/fixtures/different.mov"; }, reason: /source identity/ },
    { label: "conflicting nested provider", corrupt: (evidence) => { evidence.speech!.provider!.version = "different"; }, reason: /provider/ },
    { label: "conflicting nested revision", corrupt: (evidence) => { evidence.speech!.revision!.id = "different"; }, reason: /revision/ },
    { label: "conflicting recorded source", corrupt: (evidence) => {
      evidence.analysis[0]!.provenance!.source = { ...evidence.sourceIdentity, sourceDigest: "different" };
    }, reason: /provenance/ },
    { label: "word crossing source boundary", corrupt: (evidence) => {
      evidence.speech!.words = [{ text: "crossing", start: 4.5, end: 5.5, confidence: 1 }];
    }, reason: /crosses the occurrence source boundary/ },
    { label: "off-clock word", corrupt: (evidence) => {
      evidence.speech!.words = [{ text: "off-clock", start: 1.0001, end: 2, confidence: 1 }];
    }, reason: /declared source clock/ },
    { label: "missing exact occurrence timing", corrupt: (_evidence, project) => {
      delete (project.timeline.clips[0] as Partial<typeof project.timeline.clips[number]>).startTime;
    }, reason: /exact source and sequence timing/ },
    { label: "inexact nonzero source start", corrupt: (_evidence, project) => {
      project.timeline.clips[0]!.sourceStart = 1;
      delete project.timeline.clips[0]!.sourceStartTime;
    }, reason: /exact source and sequence timing/ },
  ];
  for (const { label, corrupt, reason } of cases) {
    await t.test(label, async () => {
      const project = await adapterFor().readProject();
      project.timeline.frameDuration = { value: "1", timescale: "25" };
      project.timeline.clips[0]!.startTime = { value: "0", timescale: "1" };
      project.timeline.clips[0]!.durationTime = { value: "5", timescale: "1" };
      const evidence = structuredClone(understanding());
      const descriptor = evidence.analysis[0]!.provenance!.analyzer;
      evidence.speech = bindSpeechAnalysis({ ...evidence.speech!, sourceTimebase: { value: "1", timescale: "1000" } }, {
        input: { project: { ...project, revision: evidence.analysisRevision }, media: project.media[0]! },
        provider: descriptor,
      });
      corrupt(evidence, project);
      const before = structuredClone(project);
      class SnapshotAdapter extends InMemoryEditorAdapter {
        public override async readProject() { return structuredClone(project); }
      }
      const adapter = new SnapshotAdapter({
        projectId: project.projectId, projectName: project.projectName,
        timelineId: project.timeline.id, timelineName: project.timeline.name,
        clips: [], media: project.media,
      });
      const store = new InMemorySemanticMediaIndexStore();
      await store.save(evidence);
      let providerCalls = 0;
      const runtime = new AgentVideoRuntime(adapter, {
        semanticMediaIndexStore: store,
        speechAnalyzer: { descriptor, analyze: async () => { providerCalls++; throw new Error("inspection must not analyze"); } },
      });
      const server = createMcpServer(runtime);
      const client = new Client({ name: "invalid-mapping-test", version: "1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const response = await client.callTool({
          name: "timeline.semantic.inspect",
          arguments: { includeSpeechMappings: true, occurrenceIds: ["occurrence-first"] },
        });
        assert.notEqual(response.isError, true, JSON.stringify(response));
        const context = JSON.parse((response.content as Array<{ text: string }>)[0]!.text);
        assert.equal(context.occurrences.length, 1);
        const occurrence = context.occurrences[0];
        assert.equal(occurrence.status, "unavailable", JSON.stringify(occurrence));
        assert.match(occurrence.reason, reason);
        assert.equal(occurrence.speechMapping, undefined);
        assert.deepEqual(occurrence.observations, []);
        assert.equal(providerCalls, 0);
        assert.deepEqual(await adapter.readProject(), before);
      } finally {
        await client.close();
        await server.close();
      }
    });
  }
});
