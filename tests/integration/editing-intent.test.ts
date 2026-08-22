import assert from "node:assert/strict";
import test from "node:test";
import { resolveEditingIntent } from "@framekit/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentVideoRuntime } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { text?: unknown } | undefined;
  assert.ok(first);
  assert.equal(typeof first.text, "string");
  return first.text as string;
}

test("editing intent maps cut-and-remove-the-rest to trim_to_duration", () => {
  assert.deepEqual(resolveEditingIntent("Cut at 30 seconds and remove the rest"), {
    status: "resolved",
    destructive: true,
    previewRequired: true,
    previewTool: "editor.native.trim-to-duration.preview",
    operation: {
      type: "trim_to_duration",
      duration: { value: "30", timescale: "1" },
    },
    affectedRange: {
      kind: "tail",
      start: { value: "30", timescale: "1" },
      end: "sequence-end",
    },
  });
});

test("editing intent maps a blade request to blade_at_playhead", () => {
  assert.deepEqual(resolveEditingIntent("Blade at 30 seconds"), {
    status: "resolved",
    destructive: true,
    previewRequired: true,
    previewTool: "editor.native.blade.preview",
    operation: {
      type: "blade_at_playhead",
      playheadTime: { value: "30", timescale: "1" },
    },
    affectedRange: {
      kind: "playhead",
      at: { value: "30", timescale: "1" },
    },
  });
});

test("editing intent maps a range removal to delete_range", () => {
  assert.deepEqual(resolveEditingIntent("Remove 10–15 seconds"), {
    status: "resolved",
    destructive: true,
    previewRequired: true,
    previewTool: "editor.native.delete-range.preview",
    operation: {
      type: "delete_range",
      range: {
        start: { value: "10", timescale: "1" },
        end: { value: "15", timescale: "1" },
      },
    },
    affectedRange: {
      kind: "range",
      start: { value: "10", timescale: "1" },
      end: { value: "15", timescale: "1" },
    },
  });
});

test("editing intent asks for clarification without selecting an operation", () => {
  assert.deepEqual(resolveEditingIntent("Cut this part out"), {
    status: "clarification_required",
    destructive: true,
    previewRequired: false,
    question: "Which editing operation should Framekit perform?",
    options: ["trim_to_duration", "blade_at_playhead", "delete_range"],
  });
});

test("editing intent does not select delete_range for a reversed range", () => {
  assert.equal(resolveEditingIntent("Remove 15-10 seconds").status, "clarification_required");
});

test("MCP exposes the resolved operation, affected range, and preview requirement", async () => {
  const server = createMcpServer(new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Intent Fixture",
    timelineId: "timeline-1",
    timelineName: "Main Edit",
    clips: [],
  })));
  const client = new Client({ name: "editing-intent-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "editing.intent.resolve"));
    const resolved = JSON.parse(textFrom(await client.callTool({
      name: "editing.intent.resolve",
      arguments: { request: "Remove 10–15 seconds" },
    })));
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.operation.type, "delete_range");
    assert.equal(resolved.previewTool, "editor.native.delete-range.preview");
    assert.deepEqual(resolved.affectedRange, {
      kind: "range",
      start: { value: "10", timescale: "1" },
      end: { value: "15", timescale: "1" },
    });
    assert.equal(resolved.previewRequired, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP intent resolution does not select or preview an ambiguous request", async () => {
  const server = createMcpServer(new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Intent Fixture",
    timelineId: "timeline-1",
    timelineName: "Main Edit",
    clips: [],
  })));
  const client = new Client({ name: "editing-intent-ambiguity-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const ambiguous = JSON.parse(textFrom(await client.callTool({
      name: "editing.intent.resolve",
      arguments: { request: "Cut this part out" },
    })));
    assert.equal(ambiguous.status, "clarification_required");
    assert.equal(ambiguous.operation, undefined);
    assert.equal(ambiguous.previewRequired, false);
  } finally {
    await client.close();
    await server.close();
  }
});
