import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AgentVideoRuntime } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";

const fixture = {
  projectId: "range-project",
  projectName: "Range Validation",
  timelineId: "range-timeline",
  timelineName: "Main Edit",
  clips: [{ id: "range-clip", mediaId: "range-media", name: "Interview", start: 0, duration: 10, track: 1 }],
  media: [{ mediaId: "range-media", source: "interview.mov", mediaKind: "video" as const, duration: 10 }],
};

function rippleDelete(start: number, end: number, timelineId = fixture.timelineId) {
  return {
    type: "ripple-delete" as const,
    timelineId,
    range: { start, end },
  };
}

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { text?: unknown } | undefined;
  assert.ok(first);
  assert.equal(typeof first?.text, "string");
  return first.text as string;
}

test("in-memory preview rejects ripple-delete ranges outside the timeline", async () => {
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter(fixture));
  const before = await runtime.inspectProject();

  for (const range of [{ start: 9, end: 11 }, { start: 11, end: 12 }]) {
    await assert.rejects(
      runtime.previewEdit({ baseRevision: before.revision, operations: [rippleDelete(range.start, range.end)] }),
      new RegExp(`ripple delete range \\[${range.start}, ${range.end}\\) must fit timeline bounds \\[0, 10\\)`),
    );
  }

  assert.deepEqual(await runtime.inspectProject(), before);
});

test("stdio MCP rejects an out-of-bounds ripple-delete before issuing a token", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(here, "../../apps/mcp-server/src/main.ts")],
    env: { ...process.env, FRAMEKIT_EDITOR: "fixture", FRAMEKIT_AUTO_CONNECT: "0" },
    stderr: "pipe",
  });
  const client = new Client({ name: "ripple-delete-range-test", version: "0.1.0" });

  try {
    await client.connect(transport);
    const beforeResult = await client.callTool({ name: "project.inspect", arguments: {} });
    const before = JSON.parse(textFrom(beforeResult));
    const result = await client.callTool({
      name: "editor.timeline.edit.preview",
      arguments: {
        projectId: before.projectId,
        sequenceId: before.timeline.id,
        baseRevision: before.revision,
        operations: [rippleDelete(9, 11, before.timeline.id)],
      },
    });

    assert.equal(result.isError, true);
    assert.match(textFrom(result), /ripple delete range \[9, 11\) must fit timeline bounds \[0, 10\)/);
    const after = JSON.parse(textFrom(await client.callTool({ name: "project.inspect", arguments: {} })));
    assert.deepEqual(after, before);
  } finally {
    await client.close();
  }
});
