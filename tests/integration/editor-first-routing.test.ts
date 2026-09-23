import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { RuntimeCapabilities } from "@framekit/runtime";
import { AgentVideoRuntime, withCapabilityFamilies } from "@framekit/runtime";
import { FinalCutProjectPublisher } from "@framekit/final-cut";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";
import {
  BACKGROUND_ARTIFACT_WORKFLOW,
  resolveEditingRoute,
  type EditorRoutingContext,
} from "../../apps/mcp-server/src/routing.js";

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

test("routing selects native picture-in-picture only with native placement guarantees", () => {
  const route = resolveEditingRoute({ operation: "editor.native.picture-in-picture" }, context({
    native: {
      pictureInPicture: true,
      mediaSelection: true,
      timelineOccurrenceLocate: true,
      timelineFocus: true,
      undo: true,
    },
  }));

  assert.equal(route.status, "editor-selected");
  assert.deepEqual(route.missingCapabilities, []);
  assert.ok(route.requiredCapabilities.includes("native.pictureInPicture"));
});

test("routing fails closed when native picture-in-picture is unavailable", () => {
  const route = resolveEditingRoute({ operation: "editor.native.picture-in-picture" }, context({
    native: { mediaSelection: true, timelineOccurrenceLocate: true, timelineFocus: true, undo: true },
  }));

  assert.equal(route.status, "unavailable");
  assert.ok(route.missingCapabilities.includes("native.pictureInPicture"));
});

test("routing separates native Undo capability from current readiness", () => {
  const route = resolveEditingRoute({ operation: "editor.native.edit" }, context({
    native: { selectionEdit: true, timelineFocus: true, undo: true },
    nativeReadiness: {
      state: "unavailable",
      nextAction: "retry",
      retryable: true,
      firstMissing: "undo",
      frontmost: true,
      timelineFocus: true,
      selectedTarget: true,
      overlay: "clear",
      permission: "granted",
      undo: "unavailable",
      guidance: "Enable an Undo command in Final Cut Pro and retry",
    },
  }));

  assert.equal(route.status, "unavailable");
  assert.equal(route.selectedPath, "none");
  assert.ok(route.requiredCapabilities.includes("native.undo"));
  assert.ok(route.missingCapabilities.includes("native.undo.ready"));
  assert.deepEqual(route.readiness, {
    state: "unavailable",
    nextAction: "retry",
    retryable: true,
    firstMissing: "undo",
    guidance: "Enable an Undo command in Final Cut Pro and retry",
  });
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

test("routing selects the background library for metadata-only project listing", () => {
  const capabilities = withCapabilityFamilies({
    editor: {
      ...canonicalCapabilities.editor,
      projectRead: false,
      timelineSnapshotRead: false,
      timelineWrite: false,
      readAfterWrite: false,
      rollback: false,
      liveStateRead: true,
      projectCatalogRead: true,
      backgroundLibraryInspection: true,
    },
    analyzers: canonicalCapabilities.analyzers,
  }, {
    backend: "final-cut-session",
    observation: {
      library: {
        available: true,
        backend: "final-cut-background-library",
        guarantee: "observed",
      },
    },
  });

  const route = resolveEditingRoute({ operation: "project.list" }, context({
    editor: {
      identity: { name: "Final Cut Pro", version: "test", backend: "final-cut-session" },
      capabilities,
    },
  }));

  assert.equal(route.status, "editor-selected");
  assert.equal(route.selectedPath, "background");
  assert.deepEqual(route.provider, {
    backend: "final-cut-background-library",
    guarantee: "observed",
  });
});

test("routing does not treat canonical artifact observation as live state", () => {
  const capabilities = withCapabilityFamilies({
    editor: {
      ...canonicalCapabilities.editor,
      timelineWrite: false,
      timelineArtifactWrite: true,
      projectCatalogRead: true,
      liveStateRead: false,
    },
    analyzers: canonicalCapabilities.analyzers,
  }, { backend: "fcpxml-document" });

  const route = resolveEditingRoute({ operation: "editor.live.inspect" }, context({
    editor: {
      identity: { name: "FCPXML Document", version: "FCPXML", backend: "fcpxml-document" },
      capabilities,
    },
  }));

  assert.equal(route.status, "unavailable");
  assert.deepEqual(route.missingCapabilities, ["observation.timeline"]);
  assert.equal(route.reason.unavailable?.category, "background-api");
  assert.equal(route.reason.unavailable?.capability, "observation.timeline");
});

test("routing does not use canonical snapshots as a background library", () => {
  const capabilities = withCapabilityFamilies({
    editor: {
      ...canonicalCapabilities.editor,
      projectCatalogRead: true,
      backgroundLibraryInspection: false,
    },
    analyzers: canonicalCapabilities.analyzers,
  }, { backend: "final-cut-native-canonical" });

  const route = resolveEditingRoute({ operation: "project.list" }, context({
    editor: {
      identity: { name: "Final Cut Pro", version: "test", backend: "final-cut-native-canonical" },
      capabilities,
    },
  }));

  assert.equal(route.status, "unavailable");
  assert.deepEqual(route.missingCapabilities, ["observation.library"]);
  assert.equal(route.reason.unavailable?.category, "background-api");
  assert.equal(route.reason.unavailable?.capability, "observation.library");
});

test("routing explains missing canonical snapshot support", () => {
  const capabilities = withCapabilityFamilies({
    editor: {
      ...canonicalCapabilities.editor,
      projectRead: false,
      timelineSnapshotRead: false,
      timelineWrite: false,
      projectCatalogRead: false,
    },
    analyzers: canonicalCapabilities.analyzers,
  }, { backend: "workflow-extension-ipc" });

  const route = resolveEditingRoute({ operation: "project.inspect" }, context({
    editor: {
      identity: { name: "Final Cut Pro", version: "test", backend: "workflow-extension-ipc" },
      capabilities,
    },
  }));

  assert.equal(route.status, "unavailable");
  assert.equal(route.reason.unavailable?.category, "canonical-snapshot");
  assert.equal(route.reason.unavailable?.capability, "canonicalDocument.read");
  assert.match(route.reason.unavailable?.message ?? "", /canonical snapshot/i);
});

test("routing explains missing native UI access", () => {
  const route = resolveEditingRoute({ operation: "editor.native.edit" }, context({
    native: { selectionEdit: false, timelineFocus: false, undo: false },
  }));

  assert.equal(route.status, "unavailable");
  assert.equal(route.reason.unavailable?.category, "native-ui");
  assert.equal(route.reason.unavailable?.capability, "native.selectionEdit");
  assert.match(route.reason.unavailable?.message ?? "", /native UI/i);
});

test("routing permits an advertised artifact editor without a live connection", () => {
  const capabilities = structuredClone(canonicalCapabilities);
  capabilities.editor.timelineWrite = false;
  capabilities.editor.timelineArtifactWrite = true;

  const route = resolveEditingRoute({ operation: "timeline.edit" }, context({
    connection: { state: "disconnected" },
    editor: {
      identity: { name: "FCPXML Document", version: "FCPXML", backend: "fcpxml-document" },
      capabilities,
    },
  }));

  assert.equal(route.status, "editor-selected");
  assert.equal(route.selectedPath, "editor");
  assert.equal(route.reason.connectionState, "disconnected");
});

test("routing selects the explicit background artifact workflow offline", () => {
  const capabilities = structuredClone(canonicalCapabilities);
  capabilities.editor.timelineWrite = false;
  capabilities.editor.timelineArtifactWrite = true;

  const route = resolveEditingRoute({ operation: "artifact.edit" }, context({
    connection: { state: "disconnected" },
    editor: {
      identity: { name: "FCPXML Document", version: "FCPXML", backend: "fcpxml-document" },
      capabilities,
    },
  }));

  assert.equal(route.status, "editor-selected");
  assert.equal(route.selectedPath, "artifact");
  assert.deepEqual(route.missingCapabilities, []);
  assert.deepEqual(route.workflow, BACKGROUND_ARTIFACT_WORKFLOW);
  assert.ok(route.requiredCapabilities.includes("editor.timelineArtifactWrite"));
  assert.match(route.reason.message, /artifact/i);
  assert.equal(route.reason.connectionState, "disconnected");
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
    for (const name of ["project.inspect", "timeline.edit", "timeline.edit.preview", "timeline.edit.execute"]) {
      const tool = tools.tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `${name} must be registered`);
      assert.match(tool.description ?? "", /editing\.route/);
      assert.match(tool.description ?? "", /capabilit/i);
    }

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

test("MCP edit handlers fail closed without a successful current route", async () => {
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
  const client = new Client({ name: "editor-first-handler-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const before = await runtime.inspectProject();
    const route = JSON.parse(textFrom(await client.callTool({
      name: "editing.route",
      arguments: { operation: "timeline.edit" },
    })));
    assert.equal(route.status, "unavailable");

    const results = await Promise.all([
      client.callTool({
        name: "timeline.edit",
        arguments: { type: "rename-clip", clipId: "missing", name: "Should not run" },
      }),
      client.callTool({
        name: "timeline.edit.preview",
        arguments: {
          baseRevision: before.revision,
          operations: [{ type: "rename-clip", clipId: "missing", name: "Should not run" }],
        },
      }),
      client.callTool({
        name: "timeline.edit.execute",
        arguments: { previewToken: "preview-unavailable" },
      }),
    ]);

    for (const result of results) {
      assert.equal(result.isError, true);
      assert.match(textFrom(result), /EDITOR_UNAVAILABLE/);
    }
    assert.deepEqual(await runtime.inspectProject(), before);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP does not advertise or invoke disabled project publishing", async () => {
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Routing Fixture",
    timelineId: "timeline-1",
    timelineName: "Main Edit",
    clips: [],
  }));
  const server = createMcpServer(runtime, {
    projectPublisher: new FinalCutProjectPublisher({
      enabled: false,
      sourcePath: "/tmp/disabled-project.fcpxml",
    }),
  });
  const client = new Client({ name: "publisher-capability-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const editor = JSON.parse(textFrom(await client.callTool({ name: "editor.inspect", arguments: {} })));
    assert.equal(editor.capabilities.editor.timelinePublishNewProject, false);

    const route = JSON.parse(textFrom(await client.callTool({
      name: "editing.route",
      arguments: { operation: "timeline.publish.new-project" },
    })));
    assert.equal(route.status, "unavailable");
    assert.equal(route.reason.code, "CAPABILITY_UNAVAILABLE");

    const publish = await client.callTool({
      name: "timeline.publish.new-project",
      arguments: { transactionId: "missing-transaction" },
    });
    assert.equal(publish.isError, true);
    assert.match(textFrom(publish), /CAPABILITY_UNAVAILABLE/);
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
  assert.match(tools, /project\.list/);
  assert.match(tools, /observation\.library/);
  assert.match(errors, /background API support/);
  assert.match(errors, /canonical snapshot support/);
  assert.match(errors, /native UI access/);
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
