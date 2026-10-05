import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentVideoRuntime, type TimelineIr } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { FfmpegMediaMetadataProbe, FfmpegRenderVerifier, FfmpegTimelineRenderer } from "../../adapters/headless/typescript/src/index.js";
import { HeadlessProjectService } from "../../apps/mcp-server/src/headless-projects.js";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

const execFileAsync = promisify(execFile);

test("production MCP exposes the persisted headless project lifecycle and verified render", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-headless-mcp-"));
  const projectDirectory = join(directory, "projects");
  try {
    await execFileAsync(process.execPath, ["scripts/generate-headless-render-fixtures.mjs", directory], { cwd: process.cwd(), env: process.env });
    const service = new HeadlessProjectService({
      directory: projectDirectory,
      mediaProbe: new FfmpegMediaMetadataProbe({ ffprobePath: process.env.FFPROBE_BIN || "ffprobe" }),
      renderer: new FfmpegTimelineRenderer({ ffmpegPath: process.env.FFMPEG_BIN || "ffmpeg" }),
      verifier: new FfmpegRenderVerifier({ ffprobePath: process.env.FFPROBE_BIN || "ffprobe" }),
      clock: () => "2026-10-05T00:00:00.000Z",
    });
    const server = createMcpServer(new AgentVideoRuntime(new InMemoryEditorAdapter({
      projectId: "editor-fixture",
      projectName: "Editor fixture",
      timelineId: "editor-sequence",
      timelineName: "Main",
      clips: [],
      media: [],
    })), { headlessProjects: service });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "headless-project-mcp-test", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listedTools = await client.listTools();
    assert.ok(listedTools.tools.some((tool) => tool.name === "headless.project.create"));
    assert.ok(listedTools.tools.some((tool) => tool.name === "headless.render.inspect"));

    const created = payload(await client.callTool({ name: "headless.project.create", arguments: { timeline: emptyTimeline() } }));
    assert.equal(created.timeline.project.id, "mcp-headless-project");
    const listed = payload(await client.callTool({ name: "headless.project.list", arguments: {} }));
    assert.equal(listed[0].projectId, "mcp-headless-project");

    const red = payload(await client.callTool({ name: "headless.media.register", arguments: {
      projectId: "mcp-headless-project",
      sourcePath: join(directory, "fixture-red-440hz.mp4"),
      expectedRevision: created.timeline.revision,
    } }));
    const blue = payload(await client.callTool({ name: "headless.media.register", arguments: {
      projectId: "mcp-headless-project",
      sourcePath: join(directory, "fixture-blue-880hz.mp4"),
      expectedRevision: red.project.timeline.revision,
    } }));
    const redResource = red.resource;
    const blueResource = blue.resource;
    const firstPreview = payload(await client.callTool({ name: "headless.edit.preview", arguments: {
      projectId: "mcp-headless-project",
      sequenceId: "mcp-headless-sequence",
      expectedRevision: blue.project.timeline.revision,
      operations: [{ type: "insert-occurrence", placement: "append", occurrence: occurrence("occurrence-red", redResource.id) }],
    } }));
    assert.equal(firstPreview.before.timeline.sequence.occurrences.length, 0);
    const first = payload(await client.callTool({ name: "headless.edit.execute", arguments: {
      projectId: "mcp-headless-project",
      sequenceId: "mcp-headless-sequence",
      expectedRevision: blue.project.timeline.revision,
      operations: [{ type: "insert-occurrence", placement: "append", occurrence: occurrence("occurrence-red", redResource.id) }],
    } }));
    const second = payload(await client.callTool({ name: "headless.edit.execute", arguments: {
      projectId: "mcp-headless-project",
      sequenceId: "mcp-headless-sequence",
      expectedRevision: first.after.timeline.revision,
      operations: [{ type: "insert-occurrence", placement: "append", occurrence: occurrence("occurrence-blue", blueResource.id) }],
    } }));
    const finished = payload(await client.callTool({ name: "headless.edit.execute", arguments: {
      projectId: "mcp-headless-project",
      sequenceId: "mcp-headless-sequence",
      expectedRevision: second.after.timeline.revision,
      operations: [
        { type: "set-gain", occurrenceId: "occurrence-red", gainDb: 6 },
        { type: "set-transform", occurrenceId: "occurrence-red", transform: { scaleX: 1.25, scaleY: 1.25 } },
        { type: "add-title", title: { id: "title-opening", text: "OPEN", startTime: { value: "0", timescale: "1" }, durationTime: { value: "1", timescale: "2" }, lane: 1 } },
        { type: "add-transition", transition: { id: "transition-red-blue", kind: "cross-dissolve", beforeOccurrenceId: "occurrence-red", afterOccurrenceId: "occurrence-blue", durationTime: { value: "1", timescale: "4" } } },
      ],
    } }));
    const render = payload(await client.callTool({ name: "headless.render", arguments: {
      projectId: "mcp-headless-project",
      sequenceId: "mcp-headless-sequence",
      expectedRevision: finished.after.timeline.revision,
      parameters: { outputPath: join(directory, "mcp-final.mp4"), format: "mp4", width: 320, height: 180, frameRate: { value: "30", timescale: "1" } },
    } }));
    assert.equal(render.status, "passed");
    assert.equal(render.outcome.verification.status, "passed");
    const inspected = payload(await client.callTool({ name: "headless.render.inspect", arguments: { renderId: render.renderId } }));
    assert.equal(inspected.status, "passed");
    assert.equal(inspected.outcome.render.projectRevision.id, finished.after.timeline.revision.id);
    await client.close();
    await server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function emptyTimeline(): TimelineIr {
  return {
    schemaVersion: 1,
    project: { id: "mcp-headless-project", name: "MCP Headless Project" },
    sequence: { id: "mcp-headless-sequence", name: "Master", durationTime: { value: "0", timescale: "1" }, frameDuration: { value: "1", timescale: "30" }, occurrences: [], storyElements: [], markers: [], captions: [], titles: [], transitions: [] },
    resources: [],
    revision: { id: "mcp-revision-0", sequence: 0, timestamp: "2026-10-05T00:00:00.000Z" },
  };
}

function occurrence(id: string, mediaId: string) {
  return { id, name: id, startTime: { value: "0", timescale: "1" }, durationTime: { value: "1", timescale: "1" }, sourceStartTime: { value: "0", timescale: "1" }, track: 0, role: "video" as const, mediaId };
}

function payload(result: unknown): any {
  const value = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  assert.equal(value.isError, undefined);
  assert.equal(value.content?.[0]?.type, "text");
  return JSON.parse(value.content?.[0]?.text ?? "null");
}
