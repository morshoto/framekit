import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type TimelineIr } from "@framekit/runtime";
import { FfmpegMediaMetadataProbe, FfmpegRenderVerifier, FfmpegTimelineRenderer } from "../../adapters/headless/typescript/src/index.js";
import { HeadlessProjectService } from "../../apps/mcp-server/src/headless-projects.js";

const execFileAsync = promisify(execFile);

test("production stdio MCP persists and reopens the headless project and render record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-headless-mcp-"));
  const here = dirname(fileURLToPath(import.meta.url));
  const environment: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    FRAMEKIT_EDITOR: "final-cut-live",
    FRAMEKIT_AUTO_CONNECT: "0",
    FRAMEKIT_FINAL_CUT_HEADLESS: "1",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0",
    FRAMEKIT_FINAL_CUT_SOCKET: join(directory, "missing-final-cut.sock"),
    FRAMEKIT_FCPXML_PATH: join(directory, "missing-project.fcpxml"),
    FRAMEKIT_STATE_DIR: directory,
  };
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  try {
    await execFileAsync(process.execPath, ["scripts/generate-headless-render-fixtures.mjs", directory], { cwd: process.cwd(), env: process.env });
    ({ client, transport } = await connectProductionClient(here, environment));

    const listedTools = await client.listTools();
    assert.ok(listedTools.tools.some((tool) => tool.name === "headless.project.create"));
    assert.ok(listedTools.tools.some((tool) => tool.name === "headless.render.inspect"));
    assert.match(client.getInstructions() ?? "", /headless Framekit-owned project/i);

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
    await transport.close();
    client = undefined;
    transport = undefined;

    ({ client, transport } = await connectProductionClient(here, environment));
    const reopened = payload(await client.callTool({ name: "headless.project.open", arguments: { projectId: "mcp-headless-project" } }));
    assert.equal(reopened.timeline.revision.id, finished.after.timeline.revision.id);
    const reopenedRender = payload(await client.callTool({ name: "headless.render.inspect", arguments: { renderId: render.renderId } }));
    assert.equal(reopenedRender.status, "passed");
    assert.equal(reopenedRender.outcome.render.projectRevision.id, finished.after.timeline.revision.id);
  } finally {
    await client?.close();
    await transport?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("headless project open fails closed when local media has no metadata probe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-headless-no-probe-"));
  try {
    const withProbe = new HeadlessProjectService({ directory, mediaProbe: new FfmpegMediaMetadataProbe() });
    const created = await withProbe.create({
      ...emptyTimeline(),
      resources: [{
        id: "local-media-1",
        name: "source.mp4",
        mediaKind: "video",
        source: "/tmp/source.mp4",
        sourceKind: "local-file",
        sourceDigest: "a".repeat(64),
      }],
    });
    const withoutProbe = new HeadlessProjectService({ directory });
    await assert.rejects(withoutProbe.open(created.timeline.project.id), (error: unknown) => (
      error instanceof Error
      && error.message.startsWith("HEADLESS_MEDIA_PROBE_UNAVAILABLE:")
    ));
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

async function connectProductionClient(here: string, environment: Record<string, string>): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(here, "../../apps/mcp-server/src/main.ts")],
    env: environment,
    stderr: "pipe",
  });
  const client = new Client({ name: "headless-project-production-stdio-test", version: "0.1.0" });
  await client.connect(transport);
  return { client, transport };
}
