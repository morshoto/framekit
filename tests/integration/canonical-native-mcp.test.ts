import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  FinalCutCanonicalNativeProvider,
  FinalCutSessionAdapter,
} from "@framekit/final-cut";
import {
  AgentVideoRuntime,
  canonicalSnapshotDigest,
  type ContextRevision,
  type EditorChange,
  type EditorIdentity,
  type EditorLiveState,
  type ProjectSnapshot,
} from "@framekit/runtime";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

const identity: EditorIdentity = {
  name: "Final Cut Pro",
  version: "10.7.1",
  backend: "workflow-extension-ipc",
};

function snapshot(clipName: string): ProjectSnapshot {
  return {
    projectId: "final-cut:project:canonical-mcp",
    projectName: "Canonical MCP",
    timeline: {
      id: "final-cut:sequence:canonical-mcp",
      name: "Main Edit",
      duration: 4,
      durationTime: { value: "96", timescale: "24" },
      frameDuration: { value: "1", timescale: "24" },
      clips: [{
        id: "final-cut:occurrence:clip-1",
        mediaId: "final-cut:media:media-1",
        name: clipName,
        start: 0,
        duration: 4,
        track: 0,
        startTime: { value: "0", timescale: "24" },
        durationTime: { value: "96", timescale: "24" },
      }],
      storyElements: [{
        id: "final-cut:occurrence:clip-1",
        kind: "asset-clip",
        start: 0,
        duration: 4,
        startTime: { value: "0", timescale: "24" },
        durationTime: { value: "96", timescale: "24" },
        lane: 0,
        mediaId: "final-cut:media:media-1",
      }],
      markers: [],
      captions: [],
    },
    media: [{ mediaId: "final-cut:media:media-1", source: "/tmp/canonical-clip.mov" }],
    revision: { id: "source-revision", sequence: 0, timestamp: new Date(0).toISOString() },
  };
}

function liveState(): EditorLiveState {
  return {
    project: { id: "final-cut:project:canonical-mcp", name: "Canonical MCP" },
    sequence: {
      id: "final-cut:sequence:canonical-mcp",
      name: "Main Edit",
      startTime: { value: "0", timescale: "24" },
      duration: { value: "96", timescale: "24" },
      frameDuration: { value: "1", timescale: "24" },
    },
    revision: { id: "live-revision", sequence: 1, timestamp: new Date(1).toISOString() },
  };
}

function createRuntime(
  calls: string[],
  readSnapshot?: () => Promise<ProjectSnapshot>,
) {
  let clipName = "Original";
  const snapshotReader = readSnapshot ?? (async () => snapshot(clipName));
  const live = {
    getIdentity: async () => identity,
    readLiveState: async () => liveState(),
    liveChangesSince: async (_revision: ContextRevision, _waitMs?: number): Promise<EditorChange[]> => [],
  };
  const provider = new FinalCutCanonicalNativeProvider({
    live,
    native: {
      renameSelectedClip: async (name) => {
        calls.push("edit");
        clipName = name;
        return { operationId: "native-operation-1", undoAvailable: true };
      },
      undo: async () => {
        calls.push("undo");
        clipName = "Original";
        return { undone: true, verification: { verified: true } };
      },
    },
    readSnapshot: snapshotReader,
    resolveTarget: async () => undefined,
    backgroundCatalog: {
      backend: "final-cut-background-library",
      listProjects: async () => ({
        projects: [{
          id: "final-cut:project:canonical-mcp",
          name: "Canonical MCP",
          sequences: [{ id: "final-cut:sequence:canonical-mcp", name: "Main Edit" }],
        }],
        activeProjectId: "final-cut:project:canonical-mcp",
        activeSequenceId: "final-cut:sequence:canonical-mcp",
      }),
    },
  });
  return new AgentVideoRuntime(new FinalCutSessionAdapter({ live: provider }));
}

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { text?: unknown } | undefined;
  assert.ok(first);
  assert.equal(typeof first.text, "string");
  return first.text as string;
}

async function connect(runtime: AgentVideoRuntime) {
  const server = createMcpServer(runtime);
  const client = new Client({ name: "canonical-native-mcp-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test("canonical native provider satisfies the MCP targeting, edit, verify, and Undo contract", async () => {
  const calls: string[] = [];
  const { client, server } = await connect(createRuntime(calls));

  try {
    const editor = JSON.parse(textFrom(await client.callTool({ name: "editor.inspect", arguments: {} })));
    assert.equal(editor.identity.backend, "final-cut-native-canonical");
    assert.equal(editor.capabilities.editor.canonicalTimelineMode, "canonical-write");
    assert.equal(editor.capabilities.editor.projectCatalogRead, true);
    assert.equal(editor.capabilities.editor.projectSelection, false);

    const selection = await client.callTool({
      name: "project.select",
      arguments: {
        projectId: "final-cut:project:canonical-mcp",
        sequenceId: "final-cut:sequence:canonical-mcp",
      },
    });
    assert.equal(selection.isError, true);
    assert.deepEqual(JSON.parse(textFrom(selection)), {
      code: "CAPABILITY_UNAVAILABLE",
      message: "project.select requires editor.projectSelection",
      operation: "project.select",
      capability: "editor.projectSelection",
      available: false,
      backend: "final-cut-native-canonical",
      guarantee: "none",
      unavailableReason: "project selection is unavailable",
    });

    const catalog = JSON.parse(textFrom(await client.callTool({ name: "project.list", arguments: {} })));
    assert.deepEqual(catalog.projects, [{
      id: "final-cut:project:canonical-mcp",
      name: "Canonical MCP",
      sequences: [{ id: "final-cut:sequence:canonical-mcp", name: "Main Edit" }],
    }]);
    assert.equal(catalog.activeProjectId, "final-cut:project:canonical-mcp");
    assert.equal(catalog.activeSequenceId, "final-cut:sequence:canonical-mcp");
    assert.equal(catalog.provenance.catalog.source, "background-library");

    const before = JSON.parse(textFrom(await client.callTool({ name: "project.inspect", arguments: {} })));
    const route = JSON.parse(textFrom(await client.callTool({
      name: "editing.route",
      arguments: { operation: "timeline.edit" },
    })));
    assert.equal(route.status, "editor-selected");
    assert.equal(route.selectedPath, "editor");

    const transaction = JSON.parse(textFrom(await client.callTool({
      name: "editor.timeline.edit",
      arguments: {
        projectId: before.projectId,
        sequenceId: before.timeline.id,
        baseRevision: before.revision,
        type: "rename-clip",
        clipId: before.timeline.clips[0].id,
        name: "Renamed by MCP",
      },
    })));
    assert.equal(transaction.status, "VERIFIED");
    assert.equal(transaction.after.timeline.clips[0].name, "Renamed by MCP");
    assert.deepEqual(calls, ["edit"]);

    const diff = JSON.parse(textFrom(await client.callTool({ name: "edit.diff", arguments: { transactionId: transaction.id } })));
    assert.equal(diff.modified.some((item: { itemId: string }) => item.itemId === before.timeline.clips[0].id), true);
    assert.equal(JSON.parse(textFrom(await client.callTool({ name: "edit.verify", arguments: { transactionId: transaction.id } }))).passed, true);

    const stale = await client.callTool({
      name: "editor.timeline.edit",
      arguments: {
        projectId: before.projectId,
        sequenceId: before.timeline.id,
        baseRevision: before.revision,
        type: "rename-clip",
        clipId: before.timeline.clips[0].id,
        name: "Stale Rename",
      },
    });
    assert.equal(stale.isError, true);
    assert.match(textFrom(stale), /STALE_CONTEXT/);

    const mismatch = await client.callTool({
      name: "editor.timeline.edit",
      arguments: {
        projectId: "wrong-project",
        sequenceId: before.timeline.id,
        baseRevision: transaction.after.revision,
        type: "rename-clip",
        clipId: before.timeline.clips[0].id,
        name: "Wrong Target",
      },
    });
    assert.equal(mismatch.isError, true);
    assert.match(textFrom(mismatch), /TARGET_MISMATCH/);

    const undone = JSON.parse(textFrom(await client.callTool({ name: "edit.undo", arguments: { transactionId: transaction.id } })));
    assert.equal(undone.timeline.clips[0].name, "Original");
    assert.deepEqual(calls, ["edit", "undo"]);
    assert.equal(canonicalSnapshotDigest(undone), canonicalSnapshotDigest(before));
  } finally {
    await client.close();
    await server.close();
  }
});

test("canonical native provider exposes a non-mutating preview-token transaction through MCP", async () => {
  const calls: string[] = [];
  const { client, server } = await connect(createRuntime(calls));

  try {
    const editor = JSON.parse(textFrom(await client.callTool({ name: "editor.inspect", arguments: {} })));
    assert.equal(editor.capabilities.editor.compositeTransactions, true);
    assert.equal(editor.capabilities.families.editing.compositeTransactions.available, true);

    const before = JSON.parse(textFrom(await client.callTool({ name: "project.inspect", arguments: {} })));
    const timeline = JSON.parse(textFrom(await client.callTool({ name: "timeline.inspect", arguments: {} })));
    assert.deepEqual(timeline, before.timeline);

    const preview = JSON.parse(textFrom(await client.callTool({
      name: "editor.timeline.edit.preview",
      arguments: {
        projectId: before.projectId,
        sequenceId: before.timeline.id,
        baseRevision: before.revision,
        operations: [{
          type: "rename-clip",
          clipId: before.timeline.clips[0].id,
          name: "Preview-token rename",
        }],
      },
    })));
    assert.equal(preview.operations[0].type, "rename-clip");
    assert.equal(preview.target.projectId, before.projectId);
    assert.equal(preview.target.sequenceId, before.timeline.id);
    assert.deepEqual(JSON.parse(textFrom(await client.callTool({ name: "project.inspect", arguments: {} }))), before);
    assert.deepEqual(calls, []);

    const transaction = JSON.parse(textFrom(await client.callTool({
      name: "editor.timeline.edit.execute",
      arguments: { previewToken: preview.previewToken },
    })));
    assert.equal(transaction.status, "VERIFIED");
    assert.equal(transaction.after.timeline.clips[0].name, "Preview-token rename");
    assert.ok(transaction.diff.modified.some((item: { itemId: string }) => item.itemId === before.timeline.clips[0].id));
    assert.ok(transaction.after.revision.sequence > before.revision.sequence);
    assert.deepEqual(calls, ["edit"]);

    const replay = await client.callTool({
      name: "editor.timeline.edit.execute",
      arguments: { previewToken: preview.previewToken },
    });
    assert.equal(replay.isError, true);
    assert.match(textFrom(replay), /PREVIEW_TOKEN_INVALID/);

    const restored = JSON.parse(textFrom(await client.callTool({
      name: "edit.undo",
      arguments: { transactionId: transaction.id },
    })));
    assert.equal(restored.timeline.clips[0].name, "Original");
    assert.deepEqual(calls, ["edit", "undo"]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP fails closed when canonical Export XML snapshot is unavailable", async () => {
  const calls: string[] = [];
  const runtime = createRuntime(calls, async () => {
    throw new Error("FINAL_CUT_CANONICAL_EXPORT_WINDOW_UNAVAILABLE: Export XML window did not appear");
  });
  const { client, server } = await connect(runtime);

  try {
    const editor = JSON.parse(textFrom(await client.callTool({ name: "editor.inspect", arguments: {} })));
    assert.equal(editor.capabilities.editor.canonicalTimelineMode, "metadata-only");
    assert.equal(editor.capabilities.editor.projectRead, false);
    assert.equal(editor.capabilities.editor.timelineSnapshotRead, false);
    assert.equal(editor.capabilities.editor.timelineWrite, false);
    assert.equal(editor.capabilities.families.canonicalDocument.read.available, false);
    assert.match(
      editor.capabilities.families.canonicalDocument.read.unavailableReason,
      /FINAL_CUT_CANONICAL_EXPORT_WINDOW_UNAVAILABLE/,
    );

    const route = JSON.parse(textFrom(await client.callTool({
      name: "editing.route",
      arguments: { operation: "timeline.edit" },
    })));
    assert.equal(route.status, "unavailable");
    assert.equal(route.selectedPath, "none");
    assert.ok(route.missingCapabilities.includes("editor.timelineSnapshotRead"));
    assert.ok(route.missingCapabilities.includes("editor.timelineWrite|editor.timelineArtifactWrite"));

    const project = await client.callTool({ name: "project.inspect", arguments: {} });
    assert.equal(project.isError, true);
    assert.deepEqual(JSON.parse(textFrom(project)), {
      code: "CAPABILITY_UNAVAILABLE",
      message: "project.inspect requires canonicalDocument.read",
      operation: "project.inspect",
      capability: "canonicalDocument.read",
      available: false,
      backend: "final-cut-native-canonical",
      guarantee: "none",
      unavailableReason: "canonical snapshot provider unavailable: FINAL_CUT_CANONICAL_EXPORT_WINDOW_UNAVAILABLE: Export XML window did not appear",
    });

    const edit = await client.callTool({
      name: "editor.timeline.edit",
      arguments: {
        projectId: "final-cut:project:canonical-mcp",
        sequenceId: "final-cut:sequence:canonical-mcp",
        baseRevision: { id: "unavailable", sequence: 0, timestamp: new Date(0).toISOString() },
        type: "rename-clip",
        clipId: "final-cut:occurrence:clip-1",
        name: "Must not mutate",
      },
    });
    assert.equal(edit.isError, true);
    assert.match(textFrom(edit), /CAPABILITY_UNAVAILABLE/);
    assert.deepEqual(calls, []);
  } finally {
    await client.close();
    await server.close();
  }
});
