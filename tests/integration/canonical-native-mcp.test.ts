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
    project: { id: "active-project", name: "Canonical MCP" },
    sequence: {
      id: "active-sequence",
      name: "Main Edit",
      startTime: { value: "0", timescale: "24" },
      duration: { value: "96", timescale: "24" },
      frameDuration: { value: "1", timescale: "24" },
    },
    revision: { id: "live-revision", sequence: 1, timestamp: new Date(1).toISOString() },
  };
}

function createRuntime(calls: string[]) {
  let clipName = "Original";
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
    readSnapshot: async () => snapshot(clipName),
    resolveTarget: async () => undefined,
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
    assert.equal(editor.capabilities.editor.projectSelection, true);

    const catalog = JSON.parse(textFrom(await client.callTool({ name: "project.list", arguments: {} })));
    assert.deepEqual(catalog, {
      projects: [{
        id: "final-cut:project:canonical-mcp",
        name: "Canonical MCP",
        sequences: [{ id: "final-cut:sequence:canonical-mcp", name: "Main Edit" }],
      }],
      activeProjectId: "final-cut:project:canonical-mcp",
      activeSequenceId: "final-cut:sequence:canonical-mcp",
    });

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
