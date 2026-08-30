import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { RuntimeCapabilities } from "@framekit/runtime";
import { AgentVideoRuntime } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";
import { resolveEditingRoute, type EditorRoutingContext } from "../../apps/mcp-server/src/routing.js";

const canonicalCapabilities: RuntimeCapabilities = {
  editor: {
    projectRead: true,
    timelineSnapshotRead: true,
    timelineWrite: true,
    timelineArtifactWrite: false,
    readAfterWrite: true,
    incrementalChanges: true,
    rollback: true,
    assetDiscovery: true,
    liveStateRead: false,
    playheadWrite: false,
    frameCapture: false,
  },
  analyzers: {
    speechTranscribe: false,
    speechVad: false,
    audioLoudness: false,
    visualTrack: false,
  },
};

function context(overrides: Partial<EditorRoutingContext> = {}): EditorRoutingContext {
  return {
    connection: { state: "ready" },
    editor: {
      identity: { name: "Fixture Editor", version: "test", backend: "fixture" },
      capabilities: canonicalCapabilities,
    },
    ...overrides,
  };
}

test("routing selects the connected editor when required capabilities are available", () => {
  const route = resolveEditingRoute({ operation: "timeline.edit" }, context());

  assert.equal(route.status, "editor-selected");
  assert.equal(route.selectedPath, "editor");
  assert.deepEqual(route.missingCapabilities, []);
  assert.deepEqual(route.editor, {
    name: "Fixture Editor",
    version: "test",
    backend: "fixture",
  });
  assert.ok(route.requiredCapabilities.includes("editor.timelineSnapshotRead"));
  assert.ok(route.requiredCapabilities.includes("editor.timelineWrite|editor.timelineArtifactWrite"));
});

test("routing fails closed when the expected editor is unavailable", () => {
  const route = resolveEditingRoute({ operation: "timeline.edit" }, context({
    connection: {
      state: "unavailable",
      lastError: { code: "FINAL_CUT_HEADLESS_SOCKET_UNAVAILABLE", message: "socket missing" },
    },
  }));

  assert.equal(route.status, "unavailable");
  assert.equal(route.selectedPath, "none");
  assert.equal(route.reason.code, "EDITOR_UNAVAILABLE");
  assert.equal(route.reason.connectionState, "unavailable");
  assert.equal(route.reason.cause?.code, "FINAL_CUT_HEADLESS_SOCKET_UNAVAILABLE");
});

test("routing reports missing capabilities before choosing an editing path", () => {
  const capabilities = structuredClone(canonicalCapabilities);
  capabilities.editor.timelineSnapshotRead = false;
  capabilities.editor.timelineWrite = false;
  capabilities.editor.timelineArtifactWrite = false;

  const route = resolveEditingRoute({ operation: "timeline.edit" }, context({
    editor: {
      identity: { name: "Final Cut Pro", version: "10.7", backend: "workflow-extension-ipc" },
      capabilities,
    },
  }));

  assert.equal(route.status, "unavailable");
  assert.equal(route.selectedPath, "none");
  assert.equal(route.reason.code, "CAPABILITY_UNAVAILABLE");
  assert.deepEqual(route.missingCapabilities, [
    "editor.timelineSnapshotRead",
    "editor.timelineWrite|editor.timelineArtifactWrite",
  ]);
});

test("routing only selects an external renderer when explicitly requested", () => {
  const route = resolveEditingRoute(
    { operation: "timeline.edit", fallback: "external-renderer" },
    context({
      connection: { state: "unavailable" },
    }),
  );

  assert.equal(route.status, "external-fallback-selected");
  assert.equal(route.selectedPath, "external-renderer");
  assert.equal(route.reason.code, "EXTERNAL_FALLBACK_SELECTED");
  assert.equal(route.reason.cause?.code, "EDITOR_UNAVAILABLE");
  assert.match(route.reason.message, /explicit/i);
});

test("explicit external selection is reported even when the editor is ready", () => {
  const route = resolveEditingRoute(
    { operation: "timeline.edit", fallback: "external-renderer" },
    context(),
  );

  assert.equal(route.status, "external-fallback-selected");
  assert.equal(route.selectedPath, "external-renderer");
  assert.equal(route.reason.cause?.code, "USER_SELECTED_EXTERNAL_FALLBACK");
});

test("MCP exposes editor-first instructions, descriptions, and routing decisions", async () => {
  const server = createMcpServer(new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Routing Fixture",
    timelineId: "timeline-1",
    timelineName: "Main Edit",
    clips: [],
  })));
  const client = new Client({ name: "editor-first-routing-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const instructions = client.getInstructions();
    assert.ok(instructions);
    for (const step of [
      "connection.status",
      "editor.inspect",
      "project.inspect",
      "editing.route",
      "preview",
      "execute",
      "edit.diff",
      "edit.verify",
    ]) assert.ok(instructions.includes(step), `missing ${step} from MCP instructions`);
    assert.ok(instructions.indexOf("connection.status") < instructions.indexOf("editor.inspect"));
    assert.ok(instructions.indexOf("editor.inspect") < instructions.indexOf("project.inspect"));

    const tools = await client.listTools();
    const routeTool = tools.tools.find((tool) => tool.name === "editing.route");
    assert.ok(routeTool);
    assert.match(routeTool.description ?? "", /capabilit/i);
    assert.match(routeTool.description ?? "", /external/i);
    assert.deepEqual(Object.keys(routeTool.inputSchema.properties ?? {}).sort(), ["fallback", "operation"]);

    const route = JSON.parse(textFrom(await client.callTool({
      name: "editing.route",
      arguments: { operation: "timeline.edit" },
    })));
    assert.equal(route.status, "editor-selected");
    assert.equal(route.selectedPath, "editor");
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP routing reports unavailable editors and explicit external fallback reasons", async () => {
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Routing Fixture",
    timelineId: "timeline-1",
    timelineName: "Main Edit",
    clips: [],
  }));
  const server = createMcpServer(runtime, {
    connectionStatus: () => ({
      state: "unavailable",
      lastError: { code: "FINAL_CUT_HEADLESS_SOCKET_UNAVAILABLE", message: "socket missing" },
    }),
  });
  const client = new Client({ name: "editor-first-fallback-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const unavailable = JSON.parse(textFrom(await client.callTool({
      name: "editing.route",
      arguments: { operation: "timeline.edit" },
    })));
    assert.equal(unavailable.status, "unavailable");
    assert.equal(unavailable.selectedPath, "none");
    assert.equal(unavailable.reason.code, "EDITOR_UNAVAILABLE");

    const fallback = JSON.parse(textFrom(await client.callTool({
      name: "editing.route",
      arguments: { operation: "timeline.edit", fallback: "external-renderer" },
    })));
    assert.equal(fallback.status, "external-fallback-selected");
    assert.equal(fallback.reason.code, "EXTERNAL_FALLBACK_SELECTED");
    assert.equal(fallback.reason.cause.code, "FINAL_CUT_HEADLESS_SOCKET_UNAVAILABLE");
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP documentation describes one consistent editor-first policy", async () => {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const [overview, tools, errors] = await Promise.all([
    readFile(resolve(repository, "docs/mcp/README.md"), "utf8"),
    readFile(resolve(repository, "docs/mcp/tools.md"), "utf8"),
    readFile(resolve(repository, "docs/mcp/capabilities-and-errors.md"), "utf8"),
  ]);

  for (const content of [overview, tools, errors]) {
    assert.match(content, /editor-first/i);
    assert.match(content, /editing\.route/);
    assert.match(content, /external-renderer/);
    assert.match(content, /CAPABILITY_UNAVAILABLE/);
  }
  for (const [before, after] of [
    ["connection.status", "editor.inspect"],
    ["editor.inspect", "project.inspect"],
    ["project.inspect", "editing.route"],
    ["editing.route", "preview"],
    ["preview", "execute"],
    ["execute", "edit.diff"],
    ["edit.diff", "edit.verify"],
  ]) {
    assert.ok(tools.indexOf(before) < tools.indexOf(after), `${before} must precede ${after}`);
  }
});

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { text?: unknown } | undefined;
  if (!first || typeof first.text !== "string") throw new Error("MCP result has no text content");
  return first.text as string;
}
