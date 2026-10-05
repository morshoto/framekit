import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { TimelineIr } from "@framekit/runtime";

const execFileAsync = promisify(execFile);

test("production stdio MCP completes the v0.1.15 headless edit-to-video release gate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-headless-release-gate-"));
  const fixtureDirectory = join(directory, "fixtures");
  const stateDirectory = join(directory, "state");
  const outputPath = join(directory, "verified-final.mp4");
  try {
    await execFileAsync(process.execPath, ["scripts/generate-headless-render-fixtures.mjs", fixtureDirectory], {
      cwd: process.cwd(),
      env: process.env,
    });
    const sourcePaths = [
      join(fixtureDirectory, "fixture-red-440hz.mp4"),
      join(fixtureDirectory, "fixture-blue-880hz.mp4"),
      join(fixtureDirectory, "fixture-green-1320hz.mp4"),
    ];
    const sourceDigestsBefore = await Promise.all(sourcePaths.map(digest));

    const first = await connectProductionServer(stateDirectory);
    let projectBeforeRestart: any;
    try {
      const tools = await first.client.listTools();
      assert.ok(tools.tools.some((tool) => tool.name === "headless.project.create"));
      assert.match(first.client.getInstructions() ?? "", /headless Framekit-owned project/i);

      const route = payload(await first.client.callTool({
        name: "editing.route",
        arguments: { operation: "timeline.edit" },
      }));
      assert.equal(route.status, "unavailable");
      assert.equal(route.selectedPath, "none");
      assert.equal(route.reason.code, "HEADLESS_UNAVAILABLE");
      assert.deepEqual(route.missingCapabilities, ["headless.timeline.edit"]);

      const created = payload(await first.client.callTool({
        name: "headless.project.create",
        arguments: { timeline: emptyTimeline() },
      }));
      const projectId = created.timeline.project.id;
      const sequenceId = created.timeline.sequence.id;

      const registrations: any[] = [];
      let revision = created.timeline.revision;
      for (const sourcePath of sourcePaths) {
        const registered = payload(await first.client.callTool({
          name: "headless.media.register",
          arguments: { projectId, sourcePath, expectedRevision: revision },
        }));
        registrations.push(registered.resource);
        revision = registered.project.timeline.revision;
      }
      assert.equal(registrations.length, 3);

      const beforePreview = payload(await first.client.callTool({
        name: "headless.project.inspect",
        arguments: { projectId },
      }));
      const preview = payload(await first.client.callTool({
        name: "headless.edit.preview",
        arguments: {
          projectId,
          sequenceId,
          expectedRevision: revision,
          operations: [{
            type: "insert-occurrence",
            placement: "append",
            occurrence: occurrence("occurrence-red", registrations[0].id),
          }],
        },
      }));
      assert.equal(preview.before.timeline.revision.sequence, revision.sequence);
      assert.equal(preview.after.timeline.sequence.occurrences.length, 1);
      assert.deepEqual(payload(await first.client.callTool({
        name: "headless.project.inspect",
        arguments: { projectId },
      })), beforePreview, "preview must not mutate the project");

      const firstEdit = payload(await first.client.callTool({
        name: "headless.edit.execute",
        arguments: {
          projectId,
          sequenceId,
          expectedRevision: revision,
          operations: [{
            type: "insert-occurrence",
            placement: "append",
            occurrence: occurrence("occurrence-red", registrations[0].id),
          }],
        },
      }));
      const secondEdit = payload(await first.client.callTool({
        name: "headless.edit.execute",
        arguments: {
          projectId,
          sequenceId,
          expectedRevision: firstEdit.after.timeline.revision,
          operations: [{
            type: "insert-occurrence",
            placement: "append",
            occurrence: occurrence("occurrence-blue", registrations[1].id),
          }],
        },
      }));
      const finished = payload(await first.client.callTool({
        name: "headless.edit.execute",
        arguments: {
          projectId,
          sequenceId,
          expectedRevision: secondEdit.after.timeline.revision,
          operations: [
            { type: "set-gain", occurrenceId: "occurrence-red", gainDb: 6 },
            { type: "set-transform", occurrenceId: "occurrence-red", transform: { scaleX: 1.25, scaleY: 1.25 } },
            { type: "add-title", title: { id: "title-opening", text: "OPEN", startTime: { value: "0", timescale: "1" }, durationTime: { value: "1", timescale: "2" }, lane: 1, style: { fontSize: 24, color: "white", alignment: "center" } } },
            { type: "add-title", title: { id: "title-closing", text: "CLOSE", startTime: { value: "3", timescale: "2" }, durationTime: { value: "1", timescale: "2" }, lane: 1 } },
            { type: "add-transition", transition: { id: "transition-red-blue", kind: "cross-dissolve", beforeOccurrenceId: "occurrence-red", afterOccurrenceId: "occurrence-blue", durationTime: { value: "1", timescale: "4" } } },
          ],
        },
      }));
      assert.equal(finished.after.timeline.resources.length, 3);
      assert.deepEqual(finished.after.timeline.sequence.occurrences.map((item: { id: string }) => item.id), ["occurrence-red", "occurrence-blue"]);
      assert.equal(finished.after.timeline.sequence.titles?.length, 2);
      assert.equal(finished.after.timeline.sequence.transitions?.length, 1);

      const stale = await first.client.callTool({
        name: "headless.edit.execute",
        arguments: {
          projectId,
          sequenceId,
          expectedRevision: revision,
          operations: [{ type: "rename-occurrence", occurrenceId: "occurrence-red", name: "stale" }],
        },
      });
      assert.equal(stale.isError, true);
      assert.equal(errorPayload(stale).code, "PROJECT_EDIT_STALE_REVISION");

      projectBeforeRestart = payload(await first.client.callTool({
        name: "headless.project.inspect",
        arguments: { projectId },
      }));
      assert.equal(projectBeforeRestart.timeline.revision.id, finished.after.timeline.revision.id);
    } finally {
      await first.client.close();
    }

    const second = await connectProductionServer(stateDirectory);
    try {
      const projectId = projectBeforeRestart.timeline.project.id;
      const sequenceId = projectBeforeRestart.timeline.sequence.id;
      const reopened = payload(await second.client.callTool({
        name: "headless.project.open",
        arguments: { projectId },
      }));
      assert.deepEqual(reopened, projectBeforeRestart, "the persisted canonical project must survive restart");
      assert.equal(reopened.timeline.resources.length, 3);

      const render = payload(await second.client.callTool({
        name: "headless.render",
        arguments: {
          projectId,
          sequenceId,
          expectedRevision: reopened.timeline.revision,
          parameters: {
            outputPath,
            format: "mp4",
            width: 320,
            height: 180,
            frameRate: { value: "30", timescale: "1" },
          },
        },
      }));
      assert.equal(render.status, "passed");
      assert.equal(render.outcome.verification.status, "passed");
      assert.equal(render.outcome.render.projectRevision.id, reopened.timeline.revision.id);
      assert.equal(render.outcome.render.renderer.id, "ffmpeg-headless");
      assert.equal(render.outcome.render.verificationRequired, true);

      const inspectedRender = payload(await second.client.callTool({
        name: "headless.render.inspect",
        arguments: { renderId: render.renderId },
      }));
      assert.equal(inspectedRender.status, "passed");
      assert.equal(inspectedRender.requestedRevision.id, reopened.timeline.revision.id);
      assert.equal(inspectedRender.outcome.verification.artifact.fileDigest, await digest(outputPath));

      const probe = JSON.parse((await execFileAsync(process.env.FFPROBE_BIN || "ffprobe", [
        "-v", "error",
        "-show_entries", "stream=codec_type,width,height,r_frame_rate,sample_rate,channels",
        "-show_entries", "format=duration",
        "-of", "json",
        outputPath,
      ], { env: process.env })).stdout) as {
        streams: Array<Record<string, string | number>>;
        format: { duration: string };
      };
      const video = probe.streams.find((stream) => stream.codec_type === "video");
      const audio = probe.streams.find((stream) => stream.codec_type === "audio");
      assert.equal(video?.width, 320);
      assert.equal(video?.height, 180);
      assert.equal(video?.r_frame_rate, "30/1");
      assert.equal(audio?.sample_rate, "48000");
      assert.equal(audio?.channels, 1);
      assert.ok(Number(probe.format.duration) > 1.95 && Number(probe.format.duration) < 2.05);

      const unsupportedPreview = payload(await second.client.callTool({
        name: "headless.edit.preview",
        arguments: {
          projectId,
          sequenceId,
          expectedRevision: reopened.timeline.revision,
          operations: [{ type: "set-transform", occurrenceId: "occurrence-red", transform: { scaleX: 1.25, scaleY: 1.25, rotationDegrees: 5 } }],
        },
      }));
      const unsupportedProject = payload(await second.client.callTool({
        name: "headless.edit.execute",
        arguments: {
          projectId,
          sequenceId,
          expectedRevision: reopened.timeline.revision,
          operations: [{ type: "set-transform", occurrenceId: "occurrence-red", transform: { scaleX: 1.25, scaleY: 1.25, rotationDegrees: 5 } }],
        },
      }));
      assert.equal(unsupportedPreview.after.timeline.revision.sequence, reopened.timeline.revision.sequence);
      assert.equal(unsupportedProject.after.timeline.revision.sequence, reopened.timeline.revision.sequence + 1);
      const unsupportedRender = payload(await second.client.callTool({
        name: "headless.render",
        arguments: {
          projectId,
          sequenceId,
          expectedRevision: unsupportedProject.after.timeline.revision,
          parameters: { outputPath: join(directory, "unsupported.mp4"), format: "mp4", width: 320, height: 180, frameRate: { value: "30", timescale: "1" } },
        },
      }));
      assert.equal(unsupportedRender.status, "unavailable", JSON.stringify(unsupportedRender));
      assert.equal(unsupportedRender.error?.code ?? unsupportedRender.outcome?.error?.code, "RENDER_CAPABILITY_UNAVAILABLE", JSON.stringify(unsupportedRender));
      await assert.rejects(stat(join(directory, "unsupported.mp4")), { code: "ENOENT" });
    } finally {
      await second.client.close();
    }

    assert.deepEqual(await Promise.all(sourcePaths.map(digest)), sourceDigestsBefore, "source media must remain unchanged");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function connectProductionServer(stateDirectory: string): Promise<{ client: Client; transport: StdioClientTransport }> {
  const environment: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    FRAMEKIT_EDITOR: "fixture",
    FRAMEKIT_AUTO_CONNECT: "0",
    FRAMEKIT_STATE_DIR: stateDirectory,
  };
  delete environment.FRAMEKIT_FCPXML_PATH;
  delete environment.FRAMEKIT_FINAL_CUT_SOCKET;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "apps/mcp-server/src/main.ts"],
    cwd: process.cwd(),
    env: environment,
    stderr: "pipe",
  });
  const client = new Client({ name: "framekit-v0.1.15-release-gate", version: "0.1.15" });
  await client.connect(transport);
  return { client, transport };
}

function emptyTimeline(): TimelineIr {
  return {
    schemaVersion: 1,
    project: { id: "release-gate-project", name: "v0.1.15 Headless Release Gate" },
    sequence: {
      id: "release-gate-sequence",
      name: "Master",
      durationTime: { value: "0", timescale: "1" },
      frameDuration: { value: "1", timescale: "30" },
      occurrences: [],
      storyElements: [],
      markers: [],
      captions: [],
      titles: [],
      transitions: [],
    },
    resources: [],
    revision: { id: "release-gate-revision-0", sequence: 0, timestamp: "2026-10-05T00:00:00.000Z" },
  };
}

function occurrence(id: string, mediaId: string) {
  return {
    id,
    name: id,
    startTime: { value: "0", timescale: "1" },
    durationTime: { value: "1", timescale: "1" },
    sourceStartTime: { value: "0", timescale: "1" },
    track: 0,
    role: "video" as const,
    mediaId,
  };
}

async function digest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function payload(result: unknown): any {
  const value = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  assert.equal(value.isError, undefined, value.content?.[0]?.text);
  assert.equal(value.content?.[0]?.type, "text");
  return JSON.parse(value.content?.[0]?.text ?? "null");
}

function errorPayload(result: unknown): { code: string; message: string } {
  const value = result as { content?: Array<{ text?: string }> };
  return JSON.parse(value.content?.[0]?.text ?? "null") as { code: string; message: string };
}
