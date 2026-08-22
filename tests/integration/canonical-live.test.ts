import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentVideoRuntime, canonicalSnapshotDigest } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import {
  FinalCutLiveAdapter,
  FinalCutSessionAdapter,
  type FinalCutLiveRequest,
  type FinalCutLiveResponse,
} from "@framekit/final-cut";
import type { EditOperation, ProjectSnapshot, RuntimeCapabilities } from "@framekit/runtime";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

const emptyAnalyzers = {
  speechTranscribe: false,
  speechVad: false,
  audioLoudness: false,
  visualTrack: false,
};

test("capability payloads distinguish metadata-only and canonical-write backends", async () => {
  const metadataOnly = new FinalCutLiveAdapter({
    request: async (request: FinalCutLiveRequest): Promise<FinalCutLiveResponse> => ({
      version: 1,
      id: request.id,
      ok: true,
      result: {
        identity: { name: "Final Cut Pro", version: "test", backend: "workflow-extension-ipc" },
        capabilities: {
          editor: {
            projectRead: true,
            timelineSnapshotRead: false,
            timelineWrite: false,
            timelineArtifactWrite: false,
            readAfterWrite: false,
            incrementalChanges: true,
            rollback: false,
            assetDiscovery: false,
            liveStateRead: true,
            playheadWrite: false,
          },
          analyzers: emptyAnalyzers,
        },
      },
    }),
  });
  assert.equal((await metadataOnly.getCapabilities()).editor.canonicalTimelineMode, "metadata-only");

  const canonicalRuntime = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Canonical",
    timelineId: "sequence-1",
    timelineName: "Main",
    clips: [],
  }));
  assert.equal(
    (await canonicalRuntime.inspectEditor()).capabilities.editor.canonicalTimelineMode,
    "canonical-write",
  );
});

const canonicalReadCapabilities: RuntimeCapabilities = {
  editor: {
    projectRead: true,
    timelineSnapshotRead: true,
    timelineWrite: false,
    timelineArtifactWrite: false,
    readAfterWrite: false,
    incrementalChanges: true,
    rollback: false,
    assetDiscovery: false,
    liveStateRead: true,
    playheadWrite: false,
    projectCatalogRead: true,
    projectSelection: true,
  },
  analyzers: emptyAnalyzers,
};

const canonicalSnapshot: ProjectSnapshot = {
  projectId: "final-cut:project:stable-project",
  projectName: "Live Canonical Project",
  timeline: {
    id: "final-cut:sequence:stable-sequence",
    name: "Main",
    duration: 8,
    durationTime: { value: "192000", timescale: "24000" },
    clips: [
      {
        id: "final-cut:occurrence:one",
        mediaId: "final-cut:media:shared",
        name: "First use",
        start: 0,
        duration: 4,
        track: 0,
        startTime: { value: "0", timescale: "24000" },
        durationTime: { value: "96000", timescale: "24000" },
      },
      {
        id: "final-cut:occurrence:two",
        mediaId: "final-cut:media:shared",
        name: "Second use",
        start: 4,
        duration: 4,
        track: 1,
        startTime: { value: "96000", timescale: "24000" },
        durationTime: { value: "96000", timescale: "24000" },
      },
    ],
    storyElements: [
      { id: "final-cut:occurrence:one", kind: "asset-clip", start: 0, duration: 4, lane: 0, mediaId: "final-cut:media:shared" },
      { id: "final-cut:occurrence:two", kind: "asset-clip", start: 4, duration: 4, lane: 1, mediaId: "final-cut:media:shared" },
    ],
    markers: [],
    captions: [],
  },
  media: [{ mediaId: "final-cut:media:shared", source: "final-cut://media/shared" }],
  revision: { id: "live-rev-7", sequence: 7, timestamp: new Date(7).toISOString() },
};

test("canonical-read live sessions expose complete snapshots with explicit stable targets", async () => {
  const requests: FinalCutLiveRequest[] = [];
  const live = new FinalCutLiveAdapter({
    request: async (request: FinalCutLiveRequest): Promise<FinalCutLiveResponse> => {
      requests.push(request);
      const result = {
        identity: { name: "Final Cut Pro", version: "test", backend: "canonical-live-ipc" },
        capabilities: canonicalReadCapabilities,
      };
      if (request.method === "snapshot") {
        return { version: 1, id: request.id, ok: true, result: { ...result, snapshot: canonicalSnapshot } };
      }
      if (request.method === "projects") {
        return {
          version: 1,
          id: request.id,
          ok: true,
          result: {
            ...result,
            catalog: {
              projects: [{
                id: canonicalSnapshot.projectId,
                name: canonicalSnapshot.projectName,
                sequences: [
                  { id: canonicalSnapshot.timeline.id, name: canonicalSnapshot.timeline.name },
                  { id: "final-cut:sequence:social", name: "Social" },
                ],
              }],
              activeProjectId: canonicalSnapshot.projectId,
              activeSequenceId: canonicalSnapshot.timeline.id,
            },
          },
        };
      }
      if (request.method === "select-project" && !request.sequenceId) {
        return {
          version: 1,
          id: request.id,
          ok: false,
          error: { code: "AMBIGUOUS_PROJECT_TARGET", message: "sequenceId is required" },
        };
      }
      return { version: 1, id: request.id, ok: true, result };
    },
  });
  const session = new FinalCutSessionAdapter({ live });
  const runtime = new AgentVideoRuntime(session);

  assert.equal((await runtime.inspectEditor()).capabilities.editor.canonicalTimelineMode, "canonical-read");
  const inspected = await runtime.inspectProject();
  assert.equal(inspected.timeline.clips.length, 2);
  assert.notEqual(inspected.timeline.clips[0]?.id, inspected.timeline.clips[1]?.id);
  assert.equal(inspected.timeline.clips[0]?.mediaId, inspected.timeline.clips[1]?.mediaId);
  assert.deepEqual(inspected.timeline.storyElements.map(({ id, lane }) => ({ id, lane })), [
    { id: "final-cut:occurrence:one", lane: 0 },
    { id: "final-cut:occurrence:two", lane: 1 },
  ]);
  await assert.rejects(
    runtime.selectProject({ projectId: canonicalSnapshot.projectId }),
    /AMBIGUOUS_PROJECT_TARGET/,
  );
  assert.ok(requests.some(({ method }) => method === "snapshot"));
});

const canonicalWriteCapabilities: RuntimeCapabilities = {
  ...canonicalReadCapabilities,
  editor: {
    ...canonicalReadCapabilities.editor,
    timelineWrite: true,
    readAfterWrite: true,
    rollback: true,
  },
};

class MutableCanonicalLiveTransport {
  public snapshot = structuredClone(canonicalSnapshot);
  public applyCalls = 0;
  private readonly history = new Map<string, ProjectSnapshot>();

  public async request(request: FinalCutLiveRequest): Promise<FinalCutLiveResponse> {
    const result = {
      identity: { name: "Final Cut Pro", version: "test", backend: "canonical-live-ipc" },
      capabilities: canonicalWriteCapabilities,
    };
    if (request.method === "snapshot") {
      return { version: 1, id: request.id, ok: true, result: { ...result, snapshot: structuredClone(this.snapshot) } };
    }
    if (request.method === "apply") {
      this.applyCalls += 1;
      if (!sameRevision(request.expectedRevision, this.snapshot.revision)) {
        return staleResponse(request.id);
      }
      this.history.set(this.snapshot.revision.id, structuredClone(this.snapshot));
      applyOperation(this.snapshot, request.operation!);
      this.advanceRevision();
    }
    if (request.method === "restore") {
      if (!sameRevision(request.expectedRevision, this.snapshot.revision)) {
        return staleResponse(request.id);
      }
      const previous = this.history.get(request.snapshot!.revision.id);
      if (!previous) {
        return {
          version: 1,
          id: request.id,
          ok: false,
          error: { code: "ROLLBACK_FAILED", message: "snapshot history is unavailable" },
        };
      }
      this.snapshot = structuredClone(previous);
      this.advanceRevision();
    }
    return { version: 1, id: request.id, ok: true, result };
  }

  private advanceRevision(): void {
    const sequence = this.snapshot.revision.sequence + 1;
    this.snapshot.revision = {
      id: `live-rev-${sequence}`,
      sequence,
      timestamp: new Date(sequence).toISOString(),
    };
  }
}

test("canonical-write live sessions return verified diffs and reject stale writes before mutation", async () => {
  const transport = new MutableCanonicalLiveTransport();
  const runtime = new AgentVideoRuntime(new FinalCutSessionAdapter({
    live: new FinalCutLiveAdapter(transport),
  }));
  const base = await runtime.inspectProject();

  const transaction = await runtime.edit({
    type: "rename-clip",
    clipId: "final-cut:occurrence:one",
    name: "Renamed live",
    baseRevision: base.revision,
  });
  assert.equal(transaction.status, "VERIFIED");
  assert.equal(transaction.before.timeline.clips[0]?.name, "First use");
  assert.equal(transaction.after.timeline.clips[0]?.name, "Renamed live");
  assert.equal(transaction.diff.modified[0]?.itemId, "final-cut:occurrence:one");

  const callsBeforeStaleAttempt = transport.applyCalls;
  await assert.rejects(runtime.edit({
    type: "rename-clip",
    clipId: "final-cut:occurrence:one",
    name: "Stale rename",
    baseRevision: base.revision,
  }), /STALE_CONTEXT/);
  assert.equal(transport.applyCalls, callsBeforeStaleAttempt);
});

test("failed canonical live verification restores the pre-edit digest", async () => {
  const transport = new MutableCanonicalLiveTransport();
  const runtime = new AgentVideoRuntime(
    new FinalCutSessionAdapter({ live: new FinalCutLiveAdapter(transport) }),
    { verificationEngine: { verify: async () => ({ passed: false, checks: [{ name: "forced", passed: false, detail: "test" }] }) } },
  );
  const before = await runtime.inspectProject();

  const transaction = await runtime.edit({
    type: "rename-clip",
    clipId: "final-cut:occurrence:one",
    name: "Must roll back",
  });

  assert.equal(transaction.status, "ROLLED_BACK");
  assert.equal(canonicalSnapshotDigest(transaction.after), canonicalSnapshotDigest(before));
  assert.equal(canonicalSnapshotDigest(await runtime.inspectProject()), canonicalSnapshotDigest(before));
});

test("MCP inspects, edits, diffs, and undoes a canonical live timeline", async () => {
  const transport = new MutableCanonicalLiveTransport();
  const runtime = new AgentVideoRuntime(new FinalCutSessionAdapter({
    live: new FinalCutLiveAdapter(transport),
  }));
  const client = new Client({ name: "canonical-live-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(runtime);
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const editor = JSON.parse(textFrom(await client.callTool({ name: "editor.inspect", arguments: {} })));
    assert.equal(editor.capabilities.editor.canonicalTimelineMode, "canonical-write");
    const before = JSON.parse(textFrom(await client.callTool({ name: "project.inspect", arguments: {} })));

    const edited = JSON.parse(textFrom(await client.callTool({
      name: "timeline.edit",
      arguments: {
        type: "rename-clip",
        clipId: "final-cut:occurrence:one",
        name: "Edited through MCP",
        baseRevision: before.revision,
      },
    })));
    assert.equal(edited.status, "VERIFIED");
    assert.equal(edited.after.timeline.clips[0].name, "Edited through MCP");

    const diff = JSON.parse(textFrom(await client.callTool({
      name: "edit.diff",
      arguments: { transactionId: edited.id },
    })));
    assert.equal(diff.modified[0].itemId, "final-cut:occurrence:one");

    const restored = JSON.parse(textFrom(await client.callTool({
      name: "edit.undo",
      arguments: { transactionId: edited.id },
    })));
    assert.equal(canonicalSnapshotDigest(restored), canonicalSnapshotDigest(before));
  } finally {
    await client.close();
    await server.close();
  }
});

function sameRevision(left: ProjectSnapshot["revision"] | undefined, right: ProjectSnapshot["revision"]): boolean {
  return Boolean(left && left.id === right.id && left.sequence === right.sequence);
}

function staleResponse(id: string): FinalCutLiveResponse {
  return {
    version: 1,
    id,
    ok: false,
    error: { code: "STALE_CONTEXT", message: "revision changed before mutation" },
  };
}

function applyOperation(snapshot: ProjectSnapshot, operation: EditOperation): void {
  if (operation.type !== "rename-clip") throw new Error(`unsupported test operation: ${operation.type}`);
  const clip = snapshot.timeline.clips.find(({ id }) => id === operation.clipId);
  if (!clip) throw new Error(`missing test clip: ${operation.clipId}`);
  clip.name = operation.name;
}

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { text?: unknown } | undefined;
  assert.equal(typeof first?.text, "string");
  return first!.text as string;
}
