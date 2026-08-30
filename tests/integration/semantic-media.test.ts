import assert from "node:assert/strict";
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
import { AgentVideoRuntime, type MediaContext } from "@framekit/runtime";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

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
