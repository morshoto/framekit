import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeCapabilities } from "@framekit/runtime";
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
