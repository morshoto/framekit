import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, rm, stat, mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  AgentVideoRuntime,
  JsonSemanticMediaIndexStore,
  type TimelineIr,
} from "@framekit/runtime";
import {
  FixtureAudioAnalyzer,
  FixtureSpeechAnalyzer,
  InMemoryEditorAdapter,
} from "@framekit/testkit";
import { FfmpegMediaMetadataProbe, FfmpegRenderVerifier, FfmpegTimelineRenderer } from "../../adapters/headless/typescript/src/index.js";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";
import { HeadlessProjectService } from "../../apps/mcp-server/src/headless-projects.js";

const execFileAsync = promisify(execFile);

test("v0.1.17 semantic media workflow runs from local MP4 to verified MP4 and editable FCPXML", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-v017-semantic-qa-"));
  let client: Client | undefined;
  let server: ReturnType<typeof createMcpServer> | undefined;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    await execFileAsync(process.execPath, ["scripts/generate-headless-render-fixtures.mjs", directory], {
      cwd: process.cwd(),
      env: process.env,
    });
    const sourcePath = join(directory, "fixture-red-440hz.mp4");
    const sourceDigest = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
    const metadata = await new FfmpegMediaMetadataProbe().probe(sourcePath);
    const sourceDuration = rationalSeconds(metadata.durationTime);
    const timeline = emptyTimeline();
    timeline.resources = [{
      id: "semantic-source",
      name: "fixture-red-440hz.mp4",
      mediaKind: "video",
      source: sourcePath,
      sourceKind: "local-file",
      sourceDigest,
      metadata,
    }];
    const projectDirectory = join(directory, "projects");
    const service = new HeadlessProjectService({
      directory: projectDirectory,
      mediaProbe: new FfmpegMediaMetadataProbe(),
      renderer: new FfmpegTimelineRenderer(),
      verifier: new FfmpegRenderVerifier(),
    });
    await service.create(timeline);

    const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({
      projectId: timeline.project.id,
      projectName: timeline.project.name,
      timelineId: timeline.sequence.id,
      timelineName: timeline.sequence.name,
      clips: [],
      media: [{
        mediaId: "semantic-source",
        source: sourcePath,
        sourceDigest,
        mediaKind: "video",
        duration: sourceDuration,
        speech: {
          words: [
            { text: "setup", start: 0.2, end: 0.6, confidence: 0.84 },
            { text: "highlight", start: 1.1, end: 1.45, confidence: 0.97 },
            { text: "moment", start: 1.5, end: 1.8, confidence: 0.95 },
          ],
          vadSegments: [
            { start: 0.2, end: 0.6, kind: "speech", confidence: 0.84 },
            { start: 0.6, end: 1.1, kind: "silence", confidence: 0.99 },
            { start: 1.1, end: 1.8, kind: "speech", confidence: 0.96 },
          ],
          silenceSegments: [{ start: 0.6, end: 1.1, kind: "silence" }],
        },
        audio: { integratedLufs: -18, truePeakDb: -1, silenceMs: 500 },
      }],
    }), {
      speechAnalyzer: new FixtureSpeechAnalyzer(),
      audioAnalyzer: new FixtureAudioAnalyzer(),
      semanticMediaIndexStore: new JsonSemanticMediaIndexStore(join(directory, "semantic-index.json")),
    });
    server = createMcpServer(runtime, { headlessProjects: service });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "framekit-v017-semantic-qa", version: "0.1.17" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const understanding = payload(await client.callTool({
      name: "media.understand",
      arguments: { mediaId: "semantic-source" },
    }));
    assert.equal(understanding.sourceIdentity.sourceDigest, sourceDigest);
    assert.equal(understanding.analysis.find((record: any) => record.capability === "speech")?.status, "analyzed");
    assert.equal(understanding.analysis.find((record: any) => record.capability === "audio")?.status, "analyzed");
    assert.deepEqual(understanding.speech.vadSegments[1], { start: 0.6, end: 1.1, kind: "silence", confidence: 0.99 });

    const indexed = payload(await client.callTool({
      name: "media.index",
      arguments: {
        query: "highlight",
        range: { start: 1.2, end: 1.7 },
        capabilities: ["speech", "audio"],
      },
    }));
    assert.equal(indexed.length, 1);
    assert.equal(indexed[0].sourceIdentity.sourceDigest, sourceDigest);
    assert.equal((await stat(join(directory, "semantic-index.json"))).isFile(), true);

    const plan = payload(await client.callTool({
      name: "rough-cut.plan",
      arguments: { query: "highlight", range: { start: 1.2, end: 1.7 }, maxShots: 1 },
    }));
    assert.equal(plan.shots.length, 1);
    assert.deepEqual(plan.shots[0].range, { start: 1.1, end: 1.8 });
    assert.equal(plan.shots[0].evidence.kind, "speech");
    assert.match(plan.shots[0].rationale, /highlight moment/);

    const outputPath = join(directory, "semantic-rough-cut.mp4");
    const fcpxmlPath = join(directory, "semantic-rough-cut.fcpxml");
    const request = {
      projectId: timeline.project.id,
      sequenceId: timeline.sequence.id,
      plan,
      render: {
        outputPath,
        format: "mp4" as const,
        width: 320,
        height: 180,
        frameRate: { value: "30", timescale: "1" },
      },
      fcpxml: {
        path: fcpxmlPath,
        target: {
          provider: "final-cut" as const,
          libraryUid: "library-v017-qa",
          eventUid: "event-v017-qa",
          projectUid: "project-v017-qa",
          sequenceUid: "sequence-v017-qa",
        },
      },
    };
    const preview = payload(await client.callTool({ name: "headless.rough-cut.preview", arguments: request }));
    assert.equal(preview.before.timeline.sequence.occurrences.length, 0);
    assert.equal(preview.provenance[0].evidence.kind, "speech");
    assert.equal(preview.after.timeline.sequence.occurrences.length, 1);

    const rejected = await client.callTool({
      name: "headless.rough-cut.execute",
      arguments: { ...request, approved: false, planDigest: preview.planDigest },
    });
    assert.equal(rejected.isError, true);
    assert.equal((await service.open(timeline.project.id)).timeline.sequence.occurrences.length, 0);

    const executed = payload(await client.callTool({
      name: "headless.rough-cut.execute",
      arguments: { ...request, approved: true, planDigest: preview.planDigest },
    }));
    assert.equal(executed.committed, true);
    assert.equal(executed.render.status, "passed");
    assert.equal(executed.fcpxmlArtifact.verified, true);
    assert.equal((await stat(outputPath)).isFile(), true);
    assert.match((await new FfmpegMediaMetadataProbe().probe(outputPath)).streams.map((stream) => stream.kind).join(","), /video/);
    assert.match(await readFile(fcpxmlPath, "utf8"), /semantic-source/);
    assert.equal((await service.open(timeline.project.id)).timeline.sequence.occurrences.length, 1);
  } finally {
    await client?.close();
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function emptyTimeline(): TimelineIr {
  return {
    schemaVersion: 1,
    project: { id: "v017-semantic-project", name: "v0.1.17 Semantic QA" },
    sequence: {
      id: "v017-semantic-sequence",
      name: "Semantic Rough Cut",
      durationTime: { value: "0", timescale: "1" },
      frameDuration: { value: "1", timescale: "30" },
      occurrences: [],
      storyElements: [],
      markers: [],
      captions: [],
    },
    resources: [],
    revision: { id: "rev-0", sequence: 0, timestamp: new Date(0).toISOString() },
  };
}

function rationalSeconds(time: { value: string; timescale: string }): number {
  return Number(time.value) / Number(time.timescale);
}

function payload(result: unknown): any {
  const value = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  assert.equal(value.isError, undefined);
  assert.equal(value.content?.[0]?.type, "text");
  return JSON.parse(value.content?.[0]?.text ?? "null");
}
