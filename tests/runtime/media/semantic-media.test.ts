import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCommandAnalyzers } from "@framekit/final-cut";
import {
  FixtureAudioAnalyzer,
  FixtureMetadataAnalyzer,
  FixtureSpeechAnalyzer,
  FixtureVisualAnalyzer,
  InMemoryEditorAdapter,
} from "@framekit/testkit";
import { AgentVideoRuntime, DIALOGUE_NORMALIZATION_DEFAULTS, InMemorySemanticMediaIndexStore, JsonSemanticMediaIndexStore, type MediaContext, type AudioAnalysis } from "@framekit/runtime";
import { createMcpServer } from "../../../apps/mcp-server/src/server.js";

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { type?: string; text?: unknown } | undefined;
  assert.equal(first?.type, "text");
  assert.equal(typeof first?.text, "string");
  return first.text as string;
}

class MutableMediaAdapter extends InMemoryEditorAdapter {
  private mediaPatch: Partial<MediaContext> | undefined;

  public replaceMedia(patch: Partial<MediaContext>): void {
    this.mediaPatch = patch;
  }

  public override async readProject() {
    const snapshot = await super.readProject();
    if (!this.mediaPatch) return snapshot;
    return {
      ...snapshot,
      media: snapshot.media.map((media) => ({ ...media, ...this.mediaPatch })),
    };
  }
}

function semanticFixture() {
  const usableRange = {
    start: 1,
    end: 4,
    startTime: { value: "100", timescale: "100" },
    durationTime: { value: "300", timescale: "100" },
  };
  const media: MediaContext = {
    mediaId: "media-semantic-1",
    source: "/fixtures/interview.mov",
    sourceDigest: "sha256:interview",
    mediaKind: "video",
    duration: 12,
    metadata: {
      environments: [{ value: "studio", confidence: 0.91 }],
      timeOfDay: [{ value: "day", confidence: 0.88 }],
      moods: [{ value: "focused", confidence: 0.86 }],
      usableRanges: [usableRange],
    },
    visual: {
      scenes: [{ id: "scene-1", start: 1, end: 4, label: "interview", confidence: 0.95 }],
      subjects: [{ id: "subject-1", label: "person", confidence: 0.99, start: 1, end: 4 }],
      keyframes: [],
    },
    speech: {
      words: [{ text: "hello", start: 1, end: 2, confidence: 0.98 }],
    },
    audio: {
      integratedLufs: -18,
      truePeakDb: -1,
      silenceMs: 0,
    },
  };
  return {
    usableRange,
    adapter: new MutableMediaAdapter({
      projectId: "project-semantic",
      projectName: "Semantic Fixture",
      timelineId: "timeline-semantic",
      timelineName: "Main Edit",
      clips: [{ id: "clip-semantic-1", mediaId: media.mediaId, name: "Interview", start: 0, duration: 12, track: 1 }],
      media: [media],
    }),
  };
}

test("media understanding preserves source identity and analyzer provenance", async () => {
  const fixture = semanticFixture();
  const runtime = new AgentVideoRuntime(fixture.adapter, {
    metadataAnalyzer: new FixtureMetadataAnalyzer(),
  });

  const understanding = await runtime.understandMedia("media-semantic-1");
  const metadata = understanding.analysis.find((record) => record.capability === "metadata");

  assert.deepEqual(understanding.sourceIdentity, {
    mediaId: "media-semantic-1",
    source: "/fixtures/interview.mov",
    sourceDigest: "sha256:interview",
    mediaKind: "video",
    duration: 12,
  });
  assert.equal(metadata?.status, "analyzed");
  assert.equal(metadata?.provenance?.analyzer.provider, "fixture");
  assert.deepEqual(metadata?.provenance?.source, understanding.sourceIdentity);
  assert.deepEqual(metadata?.provenance?.ranges, [fixture.usableRange]);
});

test("local speech and audio analysis return source-bound range evidence", async () => {
  const fixture = semanticFixture();
  const runtime = new AgentVideoRuntime(fixture.adapter, {
    speechAnalyzer: new FixtureSpeechAnalyzer(),
    audioAnalyzer: {
      descriptor: { id: "local.audio", provider: "local", version: "1" },
      analyze: async () => ({
        integratedLufs: -18,
        truePeakDb: -1,
        silenceMs: 120,
      }),
    },
  });
  const range = { start: 2, end: 5 };

  const speech = await runtime.analyzeSpeech("media-semantic-1", range);
  const audio = await runtime.analyzeAudio("media-semantic-1", range);

  assert.deepEqual(speech.sourceIdentity, {
    mediaId: "media-semantic-1",
    source: "/fixtures/interview.mov",
    sourceDigest: "sha256:interview",
    mediaKind: "video",
    duration: 12,
  });
  assert.deepEqual(speech.requestedRange, range);
  assert.deepEqual(audio.sourceIdentity, speech.sourceIdentity);
  assert.deepEqual(audio.requestedRange, range);
  assert.deepEqual(audio.measuredRange, range);
  assert.deepEqual(audio.revision, speech.revision);
  assert.deepEqual(audio.provider, { id: "local.audio", provider: "local", version: "1" });
});

test("local audio analysis rejects a source identity mismatch", async () => {
  const fixture = semanticFixture();
  const runtime = new AgentVideoRuntime(fixture.adapter, {
    audioAnalyzer: {
      analyze: async () => ({
        sourceIdentity: {
          mediaId: "media-semantic-1",
          source: "/fixtures/other.mov",
          sourceDigest: "sha256:other",
          mediaKind: "video" as const,
          duration: 12,
        },
        integratedLufs: -18,
        truePeakDb: -1,
        silenceMs: 120,
      }),
    },
  });

  await assert.rejects(
    runtime.analyzeAudio("media-semantic-1", { start: 2, end: 5 }),
    /TARGET_MISMATCH: audio analysis source identity does not match the requested media/,
  );
});

test("media understanding rejects stale audio revisions instead of caching them", async () => {
  const fixture = semanticFixture();
  const runtime = new AgentVideoRuntime(fixture.adapter, {
    audioAnalyzer: {
      analyze: async ({ project }) => ({
        revision: { ...project.revision, timestamp: "2026-01-01T00:00:00.000Z" },
        integratedLufs: -18,
        truePeakDb: -1,
        silenceMs: 120,
      }),
    },
  });

  const understanding = await runtime.understandMedia("media-semantic-1");
  const audio = understanding.analysis.find((record) => record.capability === "audio");

  assert.equal(audio?.status, "unavailable");
  assert.match(audio?.reason ?? "", /ANALYSIS_STALE: audio analysis revision/);
  assert.equal(understanding.audio, undefined);
});

test("audio analysis rejects a requested range outside the source duration", async () => {
  const fixture = semanticFixture();
  const runtime = new AgentVideoRuntime(fixture.adapter, {
    audioAnalyzer: new FixtureAudioAnalyzer(),
  });

  await assert.rejects(
    runtime.analyzeAudio("media-semantic-1", { start: 11, end: 15 }),
    /ANALYSIS_INVALID: requested audio range must be finite, positive, and inside the source duration/,
  );
});

test("audio requests reject contradictory rational ranges before provider dispatch", async (t) => {
  const cases = [
    { label: "contradictory start", startTime: { value: "2", timescale: "1" } },
    { label: "contradictory duration", durationTime: { value: "3", timescale: "1" } },
    { label: "invalid denominator", startTime: { value: "1", timescale: "0" } },
    { label: "negative start", startTime: { value: "-1", timescale: "1" } },
  ];
  for (const { label, ...coordinates } of cases) {
    await t.test(label, async () => {
      const fixture = semanticFixture();
      const before = await fixture.adapter.readProject();
      let calls = 0;
      const runtime = new AgentVideoRuntime(fixture.adapter, {
        audioAnalyzer: { analyze: async () => {
          calls++;
          return { integratedLufs: -18, truePeakDb: -1, silenceMs: 0 };
        } },
      });
      await assert.rejects(
        runtime.analyzeAudio("media-semantic-1", { start: 1, end: 3, ...coordinates }),
        /ANALYSIS_INVALID/,
      );
      assert.equal(calls, 0);
      assert.deepEqual(await fixture.adapter.readProject(), before);
    });
  }
  const fixture = semanticFixture();
  const range = {
    start: 1, end: 3,
    startTime: { value: "24000", timescale: "24000" },
    durationTime: { value: "48000", timescale: "24000" },
  };
  const runtime = new AgentVideoRuntime(fixture.adapter, { audioAnalyzer: new FixtureAudioAnalyzer() });
  const result = await runtime.analyzeAudio("media-semantic-1", range);
  assert.deepEqual(result.requestedRange, range);
  assert.deepEqual(result.measuredRange, range);
});

test("post-write audio reanalysis rejects stale revisions before verification", async () => {
  const fixture = semanticFixture();
  const runtime = new AgentVideoRuntime(fixture.adapter, {
    audioAnalyzer: {
      analyze: async ({ project }, range) => ({
        revision: { ...project.revision, timestamp: "2026-01-01T00:00:00.000Z" },
        measuredRange: range,
        integratedLufs: -18,
        truePeakDb: -1,
        silenceMs: 120,
      }),
    },
  });

  await assert.rejects(
    runtime.edit(
      { type: "rename-clip", clipId: "clip-semantic-1", name: "Interview - Clean" },
      { assertions: [{ type: "audio-loudness", mediaId: "media-semantic-1", targetLufs: -18 }] },
    ),
    /ANALYSIS_FAILED: post-write verification analysis failed \(Error: ANALYSIS_STALE: audio analysis revision/,
  );

  const restored = await runtime.inspectProject();
  assert.equal(restored.timeline.clips[0]?.name, "Interview");
});

test("media understanding cache rejects changed source identities", async () => {
  for (const patch of [
    { sourceDigest: "sha256:replacement" },
    { sourceDigest: undefined },
    { mediaKind: "audio" as const },
    { duration: 13 },
  ]) {
    const fixture = semanticFixture();
    const runtime = new AgentVideoRuntime(fixture.adapter, {
      metadataAnalyzer: new FixtureMetadataAnalyzer(),
    });

    await runtime.understandMedia("media-semantic-1");
    fixture.adapter.replaceMedia(patch);

    const inspected = await runtime.inspectProject();
    assert.equal(inspected.media[0]?.semantic, undefined, JSON.stringify(patch));
    assert.equal(inspected.media[0]?.analysis, undefined, JSON.stringify(patch));
  }
});

test("media understanding cache invalidates after a timeline revision", async () => {
  const fixture = semanticFixture();
  const runtime = new AgentVideoRuntime(fixture.adapter, {
    visualAnalyzer: new FixtureVisualAnalyzer(),
  });

  const before = await runtime.inspectProject();
  const understanding = await runtime.understandMedia("media-semantic-1");
  assert.equal(understanding.analysisRevision.id, before.revision.id);

  const transaction = await runtime.edit(
    {
      type: "rename-clip",
      clipId: "clip-semantic-1",
      name: "Interview - Clean",
    },
    { assertions: [{ type: "visual-content", mediaId: "media-semantic-1", label: "person" }] },
  );
  assert.equal(transaction.after.revision.id, "rev-1");
  assert.equal(transaction.after.media[0]?.analysisRevision, transaction.after.revision.id);

  const inspected = await runtime.inspectProject();
  const media = inspected.media[0];
  assert.equal(inspected.revision.id, transaction.after.revision.id);
  assert.equal(media?.analysisRevision, undefined);
  assert.equal(media?.semantic, undefined);
  assert.equal(media?.analysis, undefined);
});

test("attached media understanding is isolated from returned snapshots", async () => {
  const fixture = semanticFixture();
  const runtime = new AgentVideoRuntime(fixture.adapter, {
    metadataAnalyzer: new FixtureMetadataAnalyzer(),
    speechAnalyzer: new FixtureSpeechAnalyzer(),
    audioAnalyzer: new FixtureAudioAnalyzer(),
    visualAnalyzer: new FixtureVisualAnalyzer(),
  });

  await runtime.understandMedia("media-semantic-1");
  const inspected = await runtime.inspectProject();
  const media = inspected.media[0]!;
  media.metadata!.environments![0]!.value = "mutated";
  media.speech!.words[0]!.text = "mutated";
  media.audio!.integratedLufs = -1;
  media.visual!.scenes[0]!.label = "mutated";
  media.semantic!.environments[0]!.value = "mutated";
  media.analysis![0]!.status = "unavailable";

  const reread = await runtime.inspectProject();
  const rereadMedia = reread.media[0]!;
  assert.equal(rereadMedia.metadata!.environments![0]!.value, "studio");
  assert.equal(rereadMedia.speech!.words[0]!.text, "hello");
  assert.equal(rereadMedia.audio!.integratedLufs, -18);
  assert.equal(rereadMedia.visual!.scenes[0]!.label, "interview");
  assert.equal(rereadMedia.semantic!.environments[0]!.value, "studio");
  assert.equal(rereadMedia.analysis![0]!.status, "analyzed");
});

test("rough-cut confidence uses matching semantic annotations", async () => {
  const fixture = semanticFixture();
  fixture.adapter.replaceMedia({
    metadata: {
      subjects: [{ value: "person", confidence: 0.1 }],
      environments: [{ value: "studio", confidence: 0.99 }],
      usableRanges: [fixture.usableRange],
    },
  });
  const runtime = new AgentVideoRuntime(fixture.adapter, {
    metadataAnalyzer: new FixtureMetadataAnalyzer(),
  });

  await runtime.understandMedia("media-semantic-1");
  const filtered = await runtime.planRoughCut({ subject: "person" });
  const unfiltered = await runtime.planRoughCut({});

  assert.equal(filtered.shots[0]!.confidence, 0.1);
  assert.equal(unfiltered.shots[0]!.confidence, 0.99);
});

test("media understanding preserves successful results when one analyzer cannot analyze", async () => {
  const fixture = semanticFixture();
  const project = await fixture.adapter.readProject();
  project.media[0]!.visual = {
    scenes: [{ id: "scene-1", start: 1, end: 4, label: "interview", confidence: 0.95 }],
    subjects: [{ id: "subject-1", label: "person", confidence: 0.99, start: 1, end: 4 }],
    keyframes: [],
  };
  project.media[0]!.audio = undefined;
  const adapter = new InMemoryEditorAdapter({
    projectId: project.projectId,
    projectName: project.projectName,
    timelineId: project.timeline.id,
    timelineName: project.timeline.name,
    clips: project.timeline.clips,
    media: project.media,
  });
  const runtime = new AgentVideoRuntime(adapter, {
    audioAnalyzer: new FixtureAudioAnalyzer(),
    visualAnalyzer: new FixtureVisualAnalyzer(),
  });

  const understanding = await runtime.understandMedia("media-semantic-1");
  const audio = understanding.analysis.find((record) => record.capability === "audio");

  assert.equal(understanding.visual?.subjects[0]?.label, "person");
  assert.equal(audio?.status, "unavailable");
  assert.match(audio?.reason ?? "", /no audio fixture/);
});

test("semantic media index filters by meaning and usable source ranges", async () => {
  const fixture = semanticFixture();
  const runtime = new AgentVideoRuntime(fixture.adapter, {
    metadataAnalyzer: new FixtureMetadataAnalyzer(),
    visualAnalyzer: new FixtureVisualAnalyzer(),
  });

  await runtime.understandMedia("media-semantic-1");
  const matches = await runtime.indexMedia({
    subject: "person",
    scene: "interview",
    environment: "studio",
    range: { start: 2, end: 3 },
  });

  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0]?.sourceIdentity, {
    mediaId: "media-semantic-1",
    source: "/fixtures/interview.mov",
    sourceDigest: "sha256:interview",
    mediaKind: "video",
    duration: 12,
  });
  assert.equal(matches[0]?.semantic.subjects[0]?.value, "person");
  assert.deepEqual(matches[0]?.semantic.usableRanges, [fixture.usableRange]);
  assert.equal((await runtime.indexMedia({ subject: "car" })).length, 0);
  assert.equal((await runtime.indexMedia({ range: { start: 5, end: 6 } })).length, 0);
});

test("rough-cut planning returns an explainable read-only shot plan", async () => {
  const fixture = semanticFixture();
  const runtime = new AgentVideoRuntime(fixture.adapter, {
    metadataAnalyzer: new FixtureMetadataAnalyzer(),
    visualAnalyzer: new FixtureVisualAnalyzer(),
  });

  const before = await runtime.inspectProject();
  await runtime.understandMedia("media-semantic-1");
  const plan = await runtime.planRoughCut({ subject: "person", maxShots: 1 });
  const shot = plan.shots[0];

  assert.equal(plan.revision.id, before.revision.id);
  assert.equal(plan.shots.length, 1);
  assert.deepEqual(shot?.sourceIdentity, {
    mediaId: "media-semantic-1",
    source: "/fixtures/interview.mov",
    sourceDigest: "sha256:interview",
    mediaKind: "video",
    duration: 12,
  });
  assert.deepEqual(shot?.range, fixture.usableRange);
  assert.deepEqual(shot?.matchedProperties, ["subject:person"]);
  assert.match(shot?.rationale ?? "", /subject "person"/);
});

test("rough-cut planning matches individual terms across media", async () => {
  const labels = [
    { id: "media-river", source: "/fixtures/river.mov", transcript: "river hiker" },
    { id: "media-coast", source: "/fixtures/coast.mov", transcript: "cyclist coast lighthouse" },
    { id: "media-bay", source: "/fixtures/bay.mov", transcript: "sailboat bay" },
  ];
  const adapter = new InMemoryEditorAdapter({
    projectId: "project-multi-term-plan",
    projectName: "Multi-term Plan",
    timelineId: "timeline-multi-term-plan",
    timelineName: "Main Edit",
    clips: [],
    media: labels.map(({ id, source, transcript }) => ({
      mediaId: id,
      source,
      sourceDigest: `sha256:${id}`,
      mediaKind: "video",
      duration: 5,
      semantic: {
        subjects: [],
        scenes: [],
        environments: [],
        timeOfDay: [],
        moods: [],
        usableRanges: [{ start: 0, end: 5 }],
        transcript,
      },
    })),
  });
  const runtime = new AgentVideoRuntime(adapter);

  const plan = await runtime.planRoughCut({
    query: "river hiker cyclist coast lighthouse sailboat bay",
    maxShots: 3,
  });

  assert.equal(plan.shots.length, 3);
  assert.deepEqual(new Set(plan.shots.map(({ sourceIdentity }) => sourceIdentity.mediaId)), new Set(labels.map(({ id }) => id)));
});

test("rough-cut planning selects speech-first ranges and excludes silence", async () => {
  const fixture = semanticFixture();
  fixture.adapter.replaceMedia({
    metadata: { usableRanges: [] },
    speech: {
      words: [
        { text: "setup", start: 0.5, end: 1, confidence: 0.8 },
        { text: "highlight", start: 2, end: 2.5, confidence: 0.96 },
        { text: "moment", start: 2.6, end: 3.1, confidence: 0.94 },
      ],
      vadSegments: [
        { start: 0.5, end: 1, kind: "speech", confidence: 0.8 },
        { start: 1, end: 2, kind: "silence", confidence: 0.99 },
        { start: 2, end: 3.1, kind: "speech", confidence: 0.95 },
      ],
      silenceSegments: [{ start: 1, end: 2, kind: "silence" }],
    },
    audio: { integratedLufs: -18, truePeakDb: -1, silenceMs: 1000 },
  });
  const runtime = new AgentVideoRuntime(fixture.adapter, {
    speechAnalyzer: new FixtureSpeechAnalyzer(),
    audioAnalyzer: new FixtureAudioAnalyzer(),
  });

  await runtime.understandMedia("media-semantic-1");
  const plan = await runtime.planRoughCut({ query: "highlight", maxShots: 10 });
  assert.equal((await runtime.indexMedia({ query: "highlight", range: { start: 2.2, end: 2.8 } })).length, 1);
  assert.equal((await runtime.indexMedia({ query: "highlight", range: { start: 4, end: 5 } })).length, 0);

  assert.equal(plan.shots.length, 2);
  assert.deepEqual(plan.shots[0]?.range, { start: 2, end: 3.1 });
  assert.deepEqual(plan.shots[0]?.evidence, {
    kind: "speech",
    transcript: "highlight moment",
    wordCount: 2,
    averageWordConfidence: 0.95,
    vad: { kind: "speech", confidence: 0.95 },
    audio: { integratedLufs: -18, truePeakDb: -1, silenceMs: 1000 },
  });
  assert.match(plan.shots[0]?.rationale ?? "", /highlight moment/);
  assert.equal(plan.shots.some((shot) => shot.range.start === 1), false);
});

test("rough-cut planning excludes audio-only media from shots", async () => {
  const fixture = semanticFixture();
  fixture.adapter.replaceMedia({ mediaKind: "audio" });
  const runtime = new AgentVideoRuntime(fixture.adapter, {
    metadataAnalyzer: new FixtureMetadataAnalyzer(),
    visualAnalyzer: new FixtureVisualAnalyzer(),
  });

  await runtime.understandMedia("media-semantic-1");
  const plan = await runtime.planRoughCut({ subject: "person" });

  assert.deepEqual(plan.shots, []);
  assert.deepEqual(plan.warnings, [
    "Excluded audio-only media from rough-cut shot candidates: media-semantic-1",
  ]);
});

test("MCP rough-cut planning reports excluded audio-only media", async () => {
  const fixture = semanticFixture();
  fixture.adapter.replaceMedia({ mediaKind: "audio" });
  const runtime = new AgentVideoRuntime(fixture.adapter, {
    metadataAnalyzer: new FixtureMetadataAnalyzer(),
    visualAnalyzer: new FixtureVisualAnalyzer(),
  });
  await runtime.understandMedia("media-semantic-1");

  const server = createMcpServer(runtime);
  const client = new Client({ name: "audio-rough-cut-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const plan = JSON.parse(textFrom(await client.callTool({
      name: "rough-cut.plan",
      arguments: { subject: "person" },
    })));

    assert.deepEqual(plan.shots, []);
    assert.deepEqual(plan.warnings, [
      "Excluded audio-only media from rough-cut shot candidates: media-semantic-1",
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP exposes semantic indexing and rough-cut planning", async () => {
  const fixture = semanticFixture();
  const runtime = new AgentVideoRuntime(fixture.adapter, {
    metadataAnalyzer: new FixtureMetadataAnalyzer(),
    visualAnalyzer: new FixtureVisualAnalyzer(),
  });
  await runtime.understandMedia("media-semantic-1");
  const server = createMcpServer(runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "semantic-media-test", version: "0.1.0" });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const index = await client.callTool({
      name: "media.index",
      arguments: { subject: "person", range: { start: 2, end: 3 } },
    });
    assert.equal(JSON.parse(textFrom(index)).length, 1);
    const plan = await client.callTool({
      name: "rough-cut.plan",
      arguments: { subject: "person", maxShots: 1 },
    });
    assert.equal(JSON.parse(textFrom(plan)).shots[0].sourceIdentity.sourceDigest, "sha256:interview");
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP exposes source-range-bound timeline semantic context", async () => {
  const fixture = semanticFixture();
  const runtime = new AgentVideoRuntime(fixture.adapter, {
    speechAnalyzer: new FixtureSpeechAnalyzer(),
    visualAnalyzer: new FixtureVisualAnalyzer(),
    metadataAnalyzer: new FixtureMetadataAnalyzer(),
    semanticMediaIndexStore: new InMemorySemanticMediaIndexStore(),
  });
  await runtime.understandMedia("media-semantic-1");
  const server = createMcpServer(runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "timeline-semantic-context-test", version: "0.1.0" });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const context = JSON.parse(textFrom(await client.callTool({
      name: "timeline.semantic.inspect",
      arguments: { query: "hello" },
    })));

    assert.equal(context.occurrences.length, 1);
    assert.equal(context.occurrences[0].status, "available");
    assert.equal(context.occurrences[0].observations.some((observation: { text?: string }) => observation.text === "hello"), true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("metadata analyzer capability is machine-readable", async () => {
  const fixture = semanticFixture();
  const runtime = new AgentVideoRuntime(fixture.adapter, {
    metadataAnalyzer: new FixtureMetadataAnalyzer(),
  });

  const editor = await runtime.inspectEditor();

  assert.equal(editor.capabilities.analyzers.metadataDescribe, true);
});

test("unconfigured analysis returns unavailable statuses without descriptions", async () => {
  const fixture = semanticFixture();
  const runtime = new AgentVideoRuntime(fixture.adapter);

  const understanding = await runtime.understandMedia("media-semantic-1");

  assert.deepEqual(understanding.semantic.subjects, []);
  assert.deepEqual(
    understanding.analysis.map((record) => ({ capability: record.capability, status: record.status })),
    [
      { capability: "speech", status: "unavailable" },
      { capability: "audio", status: "unavailable" },
      { capability: "noise", status: "unavailable" },
      { capability: "visual", status: "unavailable" },
      { capability: "metadata", status: "unavailable" },
    ],
  );
  assert.match(understanding.analysis[0]?.reason ?? "", /not configured/);
});

test("command analyzer factory exposes independent metadata capability", () => {
  const analyzers = createCommandAnalyzers({ metadataCommand: "/usr/bin/metadata-analyzer" });

  assert.equal(analyzers.metadataAnalyzer?.descriptor?.provider, "command");
  assert.equal(analyzers.metadataAnalyzer?.descriptor?.id, "command.metadata");
});

test("semantic media index persists source-bound understanding and reuses matching analyzer cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-semantic-index-"));
  try {
    const storePath = join(directory, "index.json");
    const fixture = semanticFixture();
    const delegate = new FixtureSpeechAnalyzer();
    let calls = 0;
    const analyzer = {
      descriptor: delegate.descriptor,
      capabilities: delegate.capabilities,
      analyze: async (...args: Parameters<FixtureSpeechAnalyzer["analyze"]>) => {
        calls += 1;
        return delegate.analyze(...args);
      },
    };
    const first = new AgentVideoRuntime(fixture.adapter, {
      speechAnalyzer: analyzer,
      semanticMediaIndexStore: new JsonSemanticMediaIndexStore(storePath),
    });

    await first.understandMedia("media-semantic-1");
    assert.equal(calls, 1);

    const reopened = new AgentVideoRuntime(fixture.adapter, {
      speechAnalyzer: analyzer,
      semanticMediaIndexStore: new JsonSemanticMediaIndexStore(storePath),
    });
    await reopened.understandMedia("media-semantic-1");
    assert.equal(calls, 1);
    assert.equal((await reopened.indexMedia({ query: "hello" })).length, 1);

    fixture.adapter.replaceMedia({ sourceDigest: "sha256:replacement" });
    await reopened.understandMedia("media-semantic-1");
    assert.equal(calls, 2);
    const entries = await new JsonSemanticMediaIndexStore(storePath).list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.sourceIdentity.sourceDigest, "sha256:replacement");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("semantic media index invalidates when analyzer provenance changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-semantic-index-"));
  try {
    const storePath = join(directory, "index.json");
    const fixture = semanticFixture();
    let calls = 0;
    const analyzer = (version: string) => ({
      descriptor: { id: "fixture.speech", provider: "fixture", version },
      capabilities: { transcription: true, vad: true },
      analyze: async () => {
        calls += 1;
        return {
          words: [{ text: "cached", start: 1, end: 2, confidence: 0.9 }],
          vadSegments: [{ start: 1, end: 2, kind: "speech" as const, confidence: 0.9 }],
        };
      },
    });
    const store = new JsonSemanticMediaIndexStore(storePath);
    await new AgentVideoRuntime(fixture.adapter, { speechAnalyzer: analyzer("1"), semanticMediaIndexStore: store })
      .understandMedia("media-semantic-1");
    await new AgentVideoRuntime(fixture.adapter, { speechAnalyzer: analyzer("2"), semanticMediaIndexStore: store })
      .understandMedia("media-semantic-1");

    assert.equal(calls, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("semantic cache requires content identity before reusing source analysis", async () => {
  const fixture = semanticFixture();
  fixture.adapter.replaceMedia({ sourceDigest: undefined });
  const delegate = new FixtureSpeechAnalyzer();
  let calls = 0;
  const analyzer = {
    descriptor: delegate.descriptor,
    analyze: async (...args: Parameters<FixtureSpeechAnalyzer["analyze"]>) => {
      calls += 1;
      return delegate.analyze(...args);
    },
  };
  const store = new InMemorySemanticMediaIndexStore();
  await new AgentVideoRuntime(fixture.adapter, { speechAnalyzer: analyzer, semanticMediaIndexStore: store })
    .understandMedia("media-semantic-1");
  await new AgentVideoRuntime(fixture.adapter, { speechAnalyzer: analyzer, semanticMediaIndexStore: store })
    .understandMedia("media-semantic-1");
  assert.equal(calls, 2, "a path and revision alone cannot prove unchanged content");
});

test("semantic cache cannot relabel partial source analysis as whole-source evidence", async () => {
  const fixture = semanticFixture();
  const delegate = new FixtureSpeechAnalyzer();
  let calls = 0;
  const analyzer = {
    descriptor: delegate.descriptor,
    analyze: async (...args: Parameters<FixtureSpeechAnalyzer["analyze"]>) => {
      calls += 1;
      return delegate.analyze(...args);
    },
  };
  const store = new InMemorySemanticMediaIndexStore();
  const first = await new AgentVideoRuntime(fixture.adapter, { speechAnalyzer: analyzer, semanticMediaIndexStore: store })
    .understandMedia("media-semantic-1");
  first.speech!.requestedRange = { start: 0, end: 6 };
  first.speech!.observedRange = { start: 0, end: 6 };
  await store.save(first);
  const result = await new AgentVideoRuntime(fixture.adapter, { speechAnalyzer: analyzer, semanticMediaIndexStore: store })
    .understandMedia("media-semantic-1");
  assert.equal(calls, 2);
  assert.deepEqual(result.speech?.requestedRange, { start: 0, end: 12 });
});

test("semantic cache does not preserve analysis from a removed provider", async () => {
  const fixture = semanticFixture();
  const store = new InMemorySemanticMediaIndexStore();
  await new AgentVideoRuntime(fixture.adapter, {
    speechAnalyzer: new FixtureSpeechAnalyzer(), semanticMediaIndexStore: store,
  }).understandMedia("media-semantic-1");
  const result = await new AgentVideoRuntime(fixture.adapter, { semanticMediaIndexStore: store })
    .understandMedia("media-semantic-1");
  assert.equal(result.speech, undefined);
  assert.equal(result.analysis.find((status) => status.capability === "speech")?.status, "unavailable");
});

test("semantic cache reuses unchanged source evidence after a timeline-only revision", async () => {
  const fixture = semanticFixture();
  const delegate = new FixtureSpeechAnalyzer();
  let calls = 0;
  const analyzer = {
    descriptor: delegate.descriptor,
    analyze: async (...args: Parameters<FixtureSpeechAnalyzer["analyze"]>) => {
      calls += 1;
      return delegate.analyze(...args);
    },
  };
  const runtime = new AgentVideoRuntime(fixture.adapter, {
    speechAnalyzer: analyzer, semanticMediaIndexStore: new InMemorySemanticMediaIndexStore(),
  });
  const first = await runtime.understandMedia("media-semantic-1");
  await runtime.edit({ type: "rename-clip", clipId: "clip-semantic-1", name: "Renamed" }, { assertions: [] });
  const second = await runtime.understandMedia("media-semantic-1");
  assert.equal(calls, 1, "a timeline-only edit must not discard verified source evidence");
  assert.notEqual(second.analysisRevision.id, first.analysisRevision.id);
  assert.deepEqual(second.speech?.revision, (await runtime.inspectProject()).revision);
  assert.deepEqual(second.sourceIdentity, first.sourceIdentity);
});

for (const changedField of ["model", "configurationDigest"] as const) {
  test(`semantic cache invalidates when provider ${changedField} changes`, async () => {
    const fixture = semanticFixture();
    const store = new InMemorySemanticMediaIndexStore();
    let calls = 0;
    const analyzer = (value: string) => ({
      descriptor: { id: "configured.speech", provider: "local", version: "1", [changedField]: value },
      analyze: async () => {
        calls += 1;
        return { words: [{ text: "configured", start: 1, end: 2, confidence: 0.9 }] };
      },
    });
    await new AgentVideoRuntime(fixture.adapter, { speechAnalyzer: analyzer("first"), semanticMediaIndexStore: store })
      .understandMedia("media-semantic-1");
    await new AgentVideoRuntime(fixture.adapter, { speechAnalyzer: analyzer("second"), semanticMediaIndexStore: store })
      .understandMedia("media-semantic-1");
    assert.equal(calls, 2);
  });
}

test("source audio analysis cannot authorize an occurrence gain edit", async () => {
  const fixture = semanticFixture();
  const runtime = new AgentVideoRuntime(fixture.adapter, {
    audioAnalyzer: {
      analyze: async () => ({ integratedLufs: -20, truePeakDb: -6, silenceMs: 0, dialoguePresent: true }),
    },
  });
  const before = await runtime.inspectProject();
  const preview = await runtime.previewDialogueNormalization({
    ...DIALOGUE_NORMALIZATION_DEFAULTS,
    mediaId: "media-semantic-1", occurrenceId: "clip-semantic-1", baseRevision: before.revision,
  });
  assert.equal(preview.measurement.signalScope, "source");
  assert.equal(preview.measurement.valid, false);
  assert.equal(preview.measurement.invalidReason, "OCCURRENCE_SIGNAL_UNAVAILABLE");
  assert.equal(preview.plan.decision, "SKIP");
  assert.deepEqual(preview.operations, []);
  assert.deepEqual(await runtime.inspectProject(), before);
});

test("source audio results explicitly identify the measured signal", async () => {
  const fixture = semanticFixture();
  const runtime = new AgentVideoRuntime(fixture.adapter, { audioAnalyzer: new FixtureAudioAnalyzer() });
  const result = await runtime.analyzeAudio("media-semantic-1", { start: 1, end: 3 });
  assert.equal(result.signalScope, "source");
});

test("audio measurements reject a different occurrence before previewing edits", async () => {
  const fixture = semanticFixture();
  const runtime = new AgentVideoRuntime(fixture.adapter, {
    audioAnalyzer: {
      analyze: async () => ({
        signalScope: "occurrence" as const, occurrenceId: "wrong-occurrence",
        integratedLufs: -20, truePeakDb: -6, silenceMs: 0, dialoguePresent: true,
      }),
    },
  });
  const before = await runtime.inspectProject();
  await assert.rejects(runtime.previewDialogueNormalization({
    ...DIALOGUE_NORMALIZATION_DEFAULTS,
    mediaId: "media-semantic-1", occurrenceId: "clip-semantic-1", baseRevision: before.revision,
  }), /TARGET_MISMATCH: audio occurrence/);
  assert.deepEqual(await runtime.inspectProject(), before);
});

test("semantic cache cannot rebind occurrence loudness as reusable source analysis", async () => {
  const fixture = semanticFixture();
  const store = new InMemorySemanticMediaIndexStore();
  let calls = 0;
  const analyzer = {
    descriptor: { id: "fixture.audio", provider: "fixture", version: "1" },
    analyze: async () => {
      calls += 1;
      return { integratedLufs: -20, truePeakDb: -6, silenceMs: 0 };
    },
  };
  const runtime = () => new AgentVideoRuntime(fixture.adapter, { audioAnalyzer: analyzer, semanticMediaIndexStore: store });
  const first = await runtime().understandMedia("media-semantic-1");
  first.audio!.signalScope = "occurrence";
  first.audio!.occurrenceId = "old-occurrence";
  await store.save(first);
  const result = await runtime().understandMedia("media-semantic-1");
  assert.equal(calls, 2);
  assert.equal(result.audio?.signalScope, "source");
  assert.equal(result.audio?.occurrenceId, undefined);
});

test("cached audio payloads cannot bypass analysis validation", async (t) => {
  const cases = [
    ["nonfinite measurement", { integratedLufs: NaN }],
    ["provider-rejected measurement", { valid: false, invalidReason: "signal was not measured" }],
    ["different media identity", { mediaId: "other-media" }],
    ["different source identity", { sourceIdentity: {
      mediaId: "media-semantic-1", source: "/fixtures/other.mov", sourceDigest: "other-source", mediaKind: "video", duration: 12,
    } }],
    ["different provider identity", { provider: { id: "other.audio", provider: "fixture", version: "99" } }],
    ["different revision identity", { revision: { id: "foreign", sequence: 9, timestamp: "1970-01-01T00:00:00.000Z" } }],
    ["invalid source clock", { sourceTimebase: { value: "1", timescale: "0" } }],
    ["invalid signal format", { signalFormat: { sampleRate: 48000, channels: 0 } }],
    ["contradictory range", { measuredRange: {
      start: 0, end: 12, durationTime: { value: "20", timescale: "1" },
    } }],
  ] as const;
  for (const [label, patch] of cases) {
    for (const entrypoint of ["understanding", "index", "timeline context"]) {
      await t.test(label + " / " + entrypoint, async () => {
        const fixture = semanticFixture();
        const store = new InMemorySemanticMediaIndexStore();
        let calls = 0;
        const analyzer = {
          descriptor: { id: "fixture.cache-audio", provider: "fixture", version: "1" },
          analyze: async () => {
            calls += 1;
            return { integratedLufs: -18, truePeakDb: -1, silenceMs: 0 };
          },
        };
        const createRuntime = () => new AgentVideoRuntime(fixture.adapter, {
          audioAnalyzer: analyzer, semanticMediaIndexStore: store,
        });
        const original = await createRuntime().understandMedia("media-semantic-1");
        original.audio = { ...original.audio!, ...patch };
        await store.save(original);
        const before = await fixture.adapter.readProject();
        const runtime = createRuntime();
        if (entrypoint === "understanding") {
          const result = await runtime.understandMedia("media-semantic-1");
          assert.equal(calls, 2, "incompatible cached audio must be analyzed again");
          assert.equal(result.audio?.integratedLufs, -18);
          assert.notEqual(result.audio?.valid, false);
        } else if (entrypoint === "index") {
          const entries = await runtime.indexMedia();
          assert.equal(entries.some((entry) => entry.audio !== undefined), false);
          assert.equal(entries.some((entry) => entry.semantic.audio?.present), false);
        } else {
          const context = await runtime.inspectTimelineSemanticContext({ occurrenceIds: ["clip-semantic-1"] });
          assert.equal(context.occurrences[0]?.status, "unavailable");
          assert.deepEqual(context.occurrences[0]?.observations, []);
        }
        assert.deepEqual(await fixture.adapter.readProject(), before);
      });
    }
  }
});

test("production MCP rejects malformed audio while transcription stays available", async (t) => {
  const fixture = semanticFixture();
  const base = { integratedLufs: -18, truePeakDb: -1, silenceMs: 0 };
  let output: unknown = base;
  const runtime = new AgentVideoRuntime(fixture.adapter, {
    speechAnalyzer: new FixtureSpeechAnalyzer(),
    audioAnalyzer: { analyze: async () => output as AudioAnalysis },
  });
  const server = createMcpServer(runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "audio-validation-regression", version: "1" });
  const before = await fixture.adapter.readProject();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const cases: Array<[string, unknown]> = [
      ["infinite loudness", { ...base, integratedLufs: Infinity }],
      ["nonfinite peak", { ...base, truePeakDb: -Infinity }],
      ["negative silence", { ...base, silenceMs: -1 }],
      ["nonfinite duration", { ...base, analyzedDurationSeconds: NaN }],
      ["fractional sample count", { ...base, audibleSamples: 1.5 }],
      ["invalid source clock", { ...base, sourceTimebase: { value: "1", timescale: "0" } }],
      ["nonpositive source clock", { ...base, sourceTimebase: { value: "0", timescale: "48000" } }],
      ["contradictory measured start", { ...base, measuredRange: {
        start: 2, end: 5, startTime: { value: "200", timescale: "1" },
      } }],
      ["contradictory measured duration", { ...base, measuredRange: {
        start: 2, end: 5, durationTime: { value: "4", timescale: "1" },
      } }],
      ["zero channels", { ...base, signalFormat: { sampleRate: 48000, channels: 0 } }],
      ["nonfinite sample rate", { ...base, signalFormat: { sampleRate: Infinity, channels: 2 } }],
      ["malformed channel layout", { ...base, signalFormat: { sampleRate: 48000, channels: 2, channelLayout: "" } }],
      ["invalid validity flag", { ...base, valid: "false" }],
      ["invalid dialogue flag", { ...base, dialoguePresent: "yes" }],
      ["invalid diagnostic type", { ...base, invalidReason: 12 }],
      ["null response", null],
      ["array response", []],
      ["missing loudness", { truePeakDb: -1, silenceMs: 0 }],
    ];
    for (const [label, value] of cases) {
      await t.test(label, async () => {
        output = value;
        const result = await client.callTool({
          name: "audio.analyze", arguments: { mediaId: "media-semantic-1", range: { start: 2, end: 5 } },
        });
        assert.equal(result.isError, true, label);
        assert.match(textFrom(result), /ANALYSIS_INVALID/);
        const understanding = JSON.parse(textFrom(await client.callTool({
          name: "media.understand", arguments: { mediaId: "media-semantic-1" },
        })));
        assert.equal(understanding.audio, undefined);
        assert.equal(understanding.analysis.find((status: { capability: string }) => status.capability === "audio")?.status, "unavailable");
        assert.match(understanding.analysis.find((status: { capability: string }) => status.capability === "audio")?.reason ?? "", /ANALYSIS_INVALID/);
        assert.equal(understanding.speech.capability, "transcription-only");
        assert.equal(understanding.speech.vadSegments, undefined);
        assert.equal(understanding.analysis.find((status: { capability: string }) => status.capability === "speech")?.status, "analyzed");
        assert.deepEqual(await fixture.adapter.readProject(), before);
      });
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("media understanding does not publish provider-rejected audio as analyzed evidence", async () => {
  const fixture = semanticFixture();
  const runtime = new AgentVideoRuntime(fixture.adapter, {
    speechAnalyzer: new FixtureSpeechAnalyzer(),
    audioAnalyzer: { analyze: async () => ({
      integratedLufs: -18, truePeakDb: -1, silenceMs: 0,
      valid: false, invalidReason: "provider could not measure the requested signal",
    }) },
  });
  const result = await runtime.understandMedia("media-semantic-1");
  assert.equal(result.audio, undefined);
  const audio = result.analysis.find((entry) => entry.capability === "audio");
  assert.equal(audio?.status, "unavailable");
  assert.match(audio?.reason ?? "", /provider could not measure/);
  assert.equal(result.analysis.find((entry) => entry.capability === "speech")?.status, "analyzed");
});

test("audio occurrence measurement retains declared source clock and signal format", async () => {
  const fixture = semanticFixture();
  const format = { sampleRate: 48000, channels: 2, channelLayout: "stereo" };
  const clock = { value: "1", timescale: "48000" };
  const runtime = new AgentVideoRuntime(fixture.adapter, {
    audioAnalyzer: { analyze: async ({ occurrenceId }) => ({
      signalScope: "occurrence" as const, occurrenceId,
      integratedLufs: -20, truePeakDb: -6, silenceMs: 0, dialoguePresent: true,
      signalFormat: format, sourceTimebase: clock,
    }) },
  });
  const before = await runtime.inspectProject();
  const preview = await runtime.previewDialogueNormalization({
    ...DIALOGUE_NORMALIZATION_DEFAULTS,
    mediaId: "media-semantic-1", occurrenceId: "clip-semantic-1", baseRevision: before.revision,
  });
  assert.deepEqual(preview.measurement.signalFormat, format);
  assert.deepEqual(preview.measurement.sourceTimebase, clock);
  assert.equal(preview.plan.decision, "APPLY");
  format.channels = 9;
  clock.timescale = "1";
  assert.equal(preview.measurement.signalFormat?.channels, 2);
  assert.equal(preview.measurement.sourceTimebase?.timescale, "48000");
  assert.deepEqual(await fixture.adapter.readProject(), before);
});
