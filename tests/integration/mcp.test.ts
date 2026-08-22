import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { type?: string; text?: unknown } | undefined;
  assert.equal(first?.type, "text");
  assert.equal(typeof first?.text, "string");
  return first.text as string;
}

test("Phase 0 exposes read/write/diff through MCP stdio", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(here, "../../apps/mcp-server/src/main.ts")],
    stderr: "pipe",
  });
  const client = new Client({ name: "phase-0-test-client", version: "0.1.0" });
  let serverPid: number | null = null;

  try {
    await client.connect(transport);
    serverPid = transport.pid;
    assert.equal(typeof serverPid, "number");
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [
        "audio.analyze",
        "connection.status",
        "context.changes",
        "context.inspect",
        "edit.diff",
        "edit.undo",
        "edit.verify",
        "editor.assets",
        "editor.inspect",
        "editor.live.changes",
        "editor.live.inspect",
        "editor.native.blade.execute",
        "editor.native.blade.preview",
        "editor.native.delete-range.execute",
        "editor.native.delete-range.preview",
        "editor.native.edit",
        "editor.native.focus",
        "editor.native.inspect",
        "editor.native.media.search",
        "editor.native.media.select",
        "editor.native.media.target",
        "editor.native.timeline.locate",
        "editor.native.trim-to-duration.execute",
        "editor.native.trim-to-duration.preview",
        "editor.native.undo",
        "media.inspect",
        "media.search",
        "media.understand",
        "project.inspect",
        "project.list",
        "project.select",
        "speech.analyze",
        "timeline.changes",
        "timeline.edit",
        "timeline.inspect",
        "timeline.publish.new-project",
        "visual.analyze",
      ],
    );

    const editor = await client.callTool({ name: "editor.inspect", arguments: {} });
    const editorPayload = JSON.parse(textFrom(editor));
    assert.equal(editorPayload.identity.name, "In-memory Editor");
    const native = await client.callTool({ name: "editor.native.inspect", arguments: {} });
    assert.equal(JSON.parse(textFrom(native)).available, false);
    const focus = await client.callTool({ name: "editor.native.focus", arguments: {} });
    assert.equal(JSON.parse(textFrom(focus)).available, false);
    const connection = await client.callTool({ name: "connection.status", arguments: {} });
    assert.equal(JSON.parse(textFrom(connection)).state, "ready");

    const invalidEdit = await client.callTool({ name: "timeline.edit", arguments: { type: "ripple-delete" } });
    assert.equal(invalidEdit.isError, true);

    const media = await client.callTool({ name: "media.inspect", arguments: { mediaId: "media-1" } });
    assert.equal(JSON.parse(textFrom(media)).source, "interview.wav");
    const search = await client.callTool({ name: "media.search", arguments: { query: "wav" } });
    assert.equal(JSON.parse(textFrom(search)).length, 1);
    const assets = await client.callTool({ name: "editor.assets", arguments: {} });
    assert.equal(JSON.parse(textFrom(assets))[0].name, "Cross Dissolve");

    const context = await client.callTool({ name: "context.inspect", arguments: {} });
    assert.equal(JSON.parse(textFrom(context)).project.projectName, "Phase 2 Fixture");

    const inspected = await client.callTool({ name: "project.inspect", arguments: {} });
    const before = JSON.parse(textFrom(inspected));
    assert.equal(before.timeline.clips[0].name, "Interview");

    const edited = await client.callTool({
      name: "timeline.edit",
      arguments: { type: "rename-clip", clipId: "clip-1", name: "Interview - Clean" },
    });
    const transaction = JSON.parse(textFrom(edited));
    assert.equal(transaction.after.timeline.clips[0].name, "Interview - Clean");
    assert.equal(transaction.diff.modified[0].itemId, "clip-1");

    const changes = await client.callTool({
      name: "timeline.changes",
      arguments: { sequence: 0 },
    });
    assert.equal(JSON.parse(textFrom(changes)).modified[0].itemId, "clip-1");
    const contextChanges = await client.callTool({
      name: "context.changes",
      arguments: { sequence: 0 },
    });
    assert.equal(JSON.parse(textFrom(contextChanges)).timeline.modified[0].itemId, "clip-1");

    const speech = await client.callTool({ name: "speech.analyze", arguments: { mediaId: "media-1" } });
    assert.equal(JSON.parse(textFrom(speech)).words[0].filler, true);
    const audio = await client.callTool({ name: "audio.analyze", arguments: { mediaId: "media-1" } });
    assert.equal(JSON.parse(textFrom(audio)).integratedLufs, -18);
    const visual = await client.callTool({ name: "visual.analyze", arguments: { mediaId: "media-1" } });
    assert.equal(JSON.parse(textFrom(visual)).scenes[0].label, "interview");
    const understanding = await client.callTool({ name: "media.understand", arguments: { mediaId: "media-1" } });
    assert.equal(JSON.parse(textFrom(understanding)).visual.subjects[0].label, "person");

    const diff = await client.callTool({
      name: "edit.diff",
      arguments: { transactionId: transaction.id },
    });
    const diffPayload = JSON.parse(textFrom(diff));
    assert.equal(diffPayload.modified[0].after.name, "Interview - Clean");

    const verification = await client.callTool({
      name: "edit.verify",
      arguments: { transactionId: transaction.id },
    });
    assert.equal(JSON.parse(textFrom(verification)).passed, true);

    const markerEdit = await client.callTool({
      name: "timeline.edit",
      arguments: {
        type: "add-marker",
        timelineId: "timeline-1",
        marker: { id: "marker-1", start: 2, duration: 0, name: "Review" },
      },
    });
    assert.equal(JSON.parse(textFrom(markerEdit)).diff.markerChanges[0].type, "MARKER_ADDED");

    const undone = await client.callTool({ name: "edit.undo", arguments: { transactionId: transaction.id } });
    assert.equal(JSON.parse(textFrom(undone)).timeline.clips[0].name, "Interview");
  } finally {
    await client.close();
    await transport.close();
    if (serverPid !== null) {
      assert.throws(() => process.kill(serverPid as number, 0), /ESRCH/);
    }
  }
});
