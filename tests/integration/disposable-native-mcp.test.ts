import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DisposableNativeEditWorkflow } from "@framekit/final-cut";
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

test("MCP exposes disposable native preview, execute, and undo workflow calls", async () => {
  const calls: string[] = [];
  const disposableNative = {
    preview: async (request: unknown) => {
      calls.push(`preview:${JSON.stringify(request)}`);
      return { previewToken: "preview-1", request };
    },
    execute: async (previewToken: string) => {
      calls.push(`execute:${previewToken}`);
      return { status: "VERIFIED", operationId: "operation-1" };
    },
    undo: async (operationId: string) => {
      calls.push(`undo:${operationId}`);
      return { undone: true, operationId };
    },
  } as unknown as Pick<DisposableNativeEditWorkflow, "preview" | "execute" | "undo">;
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Disposable MCP",
    timelineId: "timeline-1",
    timelineName: "Main",
    clips: [],
    media: [],
  }));
  const server = createMcpServer(runtime, { disposableNative });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "disposable-native-mcp-test", version: "0.1.0" });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    const previewTool = tools.tools.find((tool) => tool.name === "editor.native.disposable.preview");
    assert.deepEqual(Object.keys(previewTool?.inputSchema.properties ?? {}).sort(), ["baseRevision", "clipId", "name"]);
    assert.deepEqual(previewTool?.inputSchema.required, ["clipId", "name"]);

    const preview = JSON.parse(textFrom(await client.callTool({
      name: "editor.native.disposable.preview",
      arguments: { clipId: "clip-1", name: "Renamed" },
    })));
    const executed = JSON.parse(textFrom(await client.callTool({
      name: "editor.native.disposable.execute",
      arguments: { previewToken: preview.previewToken },
    })));
    const undone = JSON.parse(textFrom(await client.callTool({
      name: "editor.native.disposable.undo",
      arguments: { operationId: executed.operationId },
    })));

    assert.equal(executed.status, "VERIFIED");
    assert.equal(undone.undone, true);
    assert.deepEqual(calls, [
      'preview:{"clipId":"clip-1","name":"Renamed"}',
      "execute:preview-1",
      "undo:operation-1",
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP keeps disposable native edits fail closed when not configured", async () => {
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Disposable MCP",
    timelineId: "timeline-1",
    timelineName: "Main",
    clips: [],
    media: [],
  }));
  const server = createMcpServer(runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "disposable-native-mcp-unavailable-test", version: "0.1.0" });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "editor.native.disposable.execute",
      arguments: { previewToken: "missing" },
    });
    assert.equal(result.isError, true);
    assert.match(textFrom(result), /CAPABILITY_UNAVAILABLE: disposable native edit is not configured/);
  } finally {
    await client.close();
    await server.close();
  }
});
