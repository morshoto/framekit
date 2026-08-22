import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentVideoRuntime } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";
import type { NativeFinalCutEditor } from "@framekit/final-cut";

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const text = (content[0] as { text?: unknown } | undefined)?.text;
  assert.equal(typeof text, "string");
  return text as string;
}

function makeRuntime(): AgentVideoRuntime {
  return new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Targeting Test",
    timelineId: "timeline-1",
    timelineName: "Main Edit",
    clips: [],
    media: [],
  }));
}

test("MCP targets one live media occurrence and reports the deterministic playhead", async () => {
  const nativeEditor = {
    capabilities: () => ({
      selectionEdit: true,
      undo: true,
      mediaLibrarySearch: true,
      mediaSelection: true,
      timelineOccurrenceLocate: true,
      bladeAtPlayhead: true,
      deleteRange: true,
      trimToDuration: true,
      timelineFocus: true,
      requiresAccessibility: true as const,
      requiresFinalCutFrontmost: true as const,
    }),
    targetMedia: async (query: string) => ({
      query,
      status: "unique" as const,
      media: { handle: "media-1", name: "Interview.mov", role: "AXBrowserMedia" },
      occurrence: {
        handle: "occurrence-1",
        mediaHandle: "media-1",
        name: "Interview.mov",
        start: "24000/24000",
        duration: "48000/24000",
      },
      selected: true,
      playheadTime: "24000/24000",
    }),
  } as unknown as NativeFinalCutEditor;
  const server = createMcpServer(makeRuntime(), { nativeEditor });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "media-targeting-test", version: "0.1.0" });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "editor.native.media.target"));

    const result = await client.callTool({
      name: "editor.native.media.target",
      arguments: { query: "Interview" },
    });
    const payload = JSON.parse(textFrom(result));
    assert.equal(payload.status, "unique");
    assert.equal(payload.media.handle, "media-1");
    assert.equal(payload.occurrence.handle, "occurrence-1");
    assert.equal(payload.selected, true);
    assert.equal(payload.playheadTime, "24000/24000");
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP exposes distinct fail-closed media targeting errors", async () => {
  const nativeEditor = {
    capabilities: () => ({
      selectionEdit: true,
      undo: true,
      mediaLibrarySearch: true,
      mediaSelection: true,
      timelineOccurrenceLocate: true,
      bladeAtPlayhead: true,
      deleteRange: true,
      trimToDuration: true,
      timelineFocus: true,
      requiresAccessibility: true as const,
      requiresFinalCutFrontmost: true as const,
    }),
    targetMedia: async (query: string) => {
      throw new Error(query === "missing"
        ? "FINAL_CUT_NATIVE_MEDIA_NOT_FOUND: no Browser media matched the query"
        : "FINAL_CUT_NATIVE_AMBIGUOUS_TARGET: media query matched multiple timeline targets");
    },
  } as unknown as NativeFinalCutEditor;
  const server = createMcpServer(makeRuntime(), { nativeEditor });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "media-targeting-errors-test", version: "0.1.0" });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const missing = await client.callTool({
      name: "editor.native.media.target",
      arguments: { query: "missing" },
    });
    const ambiguous = await client.callTool({
      name: "editor.native.media.target",
      arguments: { query: "ambiguous" },
    });
    assert.equal(missing.isError, true);
    assert.match(textFrom(missing), /FINAL_CUT_NATIVE_MEDIA_NOT_FOUND/);
    assert.equal(ambiguous.isError, true);
    assert.match(textFrom(ambiguous), /FINAL_CUT_NATIVE_AMBIGUOUS_TARGET/);
  } finally {
    await client.close();
    await server.close();
  }
});
