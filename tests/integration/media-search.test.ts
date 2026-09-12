import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentVideoRuntime, type RuntimeCapabilities } from "@framekit/runtime";
import {
  FinalCutLiveAdapter,
  FinalCutSessionAdapter,
  type FinalCutLiveRequest,
  type FinalCutLiveResponse,
} from "@framekit/final-cut";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

const metadataOnlyCapabilities: RuntimeCapabilities = {
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
    frameCapture: false,
  },
  analyzers: {
    speechTranscribe: false,
    speechVad: false,
    audioLoudness: false,
    visualTrack: false,
  },
};

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { text?: unknown } | undefined;
  assert.equal(typeof first?.text, "string");
  return first?.text as string;
}

test("media.search returns structured media observation unavailability", async () => {
  const live = new FinalCutLiveAdapter({
    request: async (request: FinalCutLiveRequest): Promise<FinalCutLiveResponse> => ({
      version: 1,
      id: request.id,
      ok: true,
      result: {
        identity: { name: "Final Cut Pro", version: "test", backend: "workflow-extension-ipc" },
        capabilities: metadataOnlyCapabilities,
      },
    }),
  });
  const runtime = new AgentVideoRuntime(new FinalCutSessionAdapter({ live }));
  const server = createMcpServer(runtime);
  const client = new Client({ name: "media-search-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const editor = JSON.parse(textFrom(await client.callTool({ name: "editor.inspect", arguments: {} })));
    assert.deepEqual(editor.capabilities.families.observation.media, {
      available: false,
      backend: "workflow-extension-ipc",
      guarantee: "none",
      unavailableReason: "media observation is unavailable",
    });

    const result = await client.callTool({ name: "media.search", arguments: { query: "video" } });

    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse(textFrom(result)), {
      code: "CAPABILITY_UNAVAILABLE",
      message: "media.search requires observation.media",
      operation: "media.search",
      capability: "observation.media",
      available: false,
      backend: "workflow-extension-ipc",
      guarantee: "none",
      unavailableReason: "media observation is unavailable",
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("media.search preserves successful empty results", async () => {
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Search Fixture",
    timelineId: "timeline-1",
    timelineName: "Main",
    clips: [],
    media: [{ mediaId: "media-1", source: "interview.mov" }],
  }));
  const server = createMcpServer(runtime);
  const client = new Client({ name: "media-search-empty-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: "media.search", arguments: { query: "missing" } });

    assert.notEqual(result.isError, true);
    assert.deepEqual(JSON.parse(textFrom(result)), []);
  } finally {
    await client.close();
    await server.close();
  }
});
