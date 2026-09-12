import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FinalCutLiveAdapter, FinalCutSessionAdapter } from "@framekit/final-cut";
import type { RuntimeCapabilities } from "@framekit/runtime";
import { AgentVideoRuntime } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";
import { FRAMEKIT_BUILD_FINGERPRINT, FRAMEKIT_VERSION } from "../../apps/mcp-server/src/version.js";

const bridgeCapabilities: RuntimeCapabilities = {
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
  assert.ok(first);
  assert.equal(typeof first?.text, "string");
  return first.text as string;
}

function metadataOnlyRuntime(): AgentVideoRuntime {
  const live = new FinalCutLiveAdapter({
    request: async (request) => ({
      version: 1,
      id: request.id,
      ok: true,
      result: {
        identity: { name: "Final Cut Pro", version: "10.7.1", backend: "workflow-extension-ipc" },
        capabilities: bridgeCapabilities,
      },
    }),
  });
  return new AgentVideoRuntime(new FinalCutSessionAdapter({ live }));
}

class FailingInspectionAdapter extends InMemoryEditorAdapter {
  public override async getIdentity(): Promise<never> {
    throw new Error("CAPABILITY_UNAVAILABLE: runtime inspection unavailable");
  }
}

async function withClient(
  runtime: AgentVideoRuntime,
  callback: (client: Client) => Promise<void>,
): Promise<void> {
  const server = createMcpServer(runtime, {
    processMode: "headless",
    buildFingerprint: { version: "0.1.7", commit: "test-commit" },
    connectionStatus: () => ({
      state: "ready",
      editorDetected: true,
      extensionInstalled: true,
      identity: { name: "Final Cut Pro", version: "10.7.1", backend: "workflow-extension-ipc" },
      capabilities: bridgeCapabilities,
    }),
  });
  const client = new Client({ name: "runtime-alignment-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await callback(client);
  } finally {
    await client.close();
    await server.close();
  }
}

test("the default build fingerprint identifies its package and source commit", () => {
  assert.equal(FRAMEKIT_BUILD_FINGERPRINT.version, FRAMEKIT_VERSION);
  assert.match(FRAMEKIT_BUILD_FINGERPRINT.commit, /^[0-9a-f]{40}$/i);
});

test("connection status and editor inspection share effective preflight", async () => {
  await withClient(metadataOnlyRuntime(), async (client) => {
    const status = JSON.parse(textFrom(await client.callTool({ name: "connection.status", arguments: {} })));
    const editor = JSON.parse(textFrom(await client.callTool({ name: "editor.inspect", arguments: {} })));

    assert.deepEqual(status.identity, editor.identity);
    assert.deepEqual(status.capabilities, editor.capabilities);
    assert.deepEqual(status.preflight, editor.preflight);
    assert.equal(status.capabilities.editor.projectRead, false);
    assert.equal(status.preflight.fingerprint.version, "0.1.7");
    assert.equal(status.preflight.fingerprint.commit, "test-commit");
  });
});

test("connection status becomes unavailable when inspection fails", async () => {
  const runtime = new AgentVideoRuntime(new FailingInspectionAdapter({
    projectId: "project-1",
    projectName: "Inspection Failure Fixture",
    timelineId: "timeline-1",
    timelineName: "Main",
    clips: [],
  }));

  await withClient(runtime, async (client) => {
    const status = JSON.parse(textFrom(await client.callTool({ name: "connection.status", arguments: {} })));

    assert.equal(status.state, "unavailable");
    assert.deepEqual(status.lastError, {
      code: "CAPABILITY_UNAVAILABLE",
      message: "effective runtime capability inspection failed: CAPABILITY_UNAVAILABLE: runtime inspection unavailable",
    });
    assert.equal(status.capabilities, undefined);
    assert.equal(status.preflight, undefined);
  });
});

test("metadata-only project and media operations return structured capability failures", async () => {
  await withClient(metadataOnlyRuntime(), async (client) => {
    const project = await client.callTool({ name: "project.inspect", arguments: {} });
    assert.equal(project.isError, true);
    assert.deepEqual(JSON.parse(textFrom(project)), {
      code: "CAPABILITY_UNAVAILABLE",
      message: "project.inspect requires canonicalDocument.read",
      operation: "project.inspect",
      capability: "canonicalDocument.read",
      available: false,
      backend: "final-cut-session",
      guarantee: "none",
      unavailableReason: "canonical timeline reads are unavailable",
    });

    const media = await client.callTool({ name: "media.search", arguments: { query: "video" } });
    assert.equal(media.isError, true);
    assert.deepEqual(JSON.parse(textFrom(media)), {
      code: "CAPABILITY_UNAVAILABLE",
      message: "media.search requires observation.media",
      operation: "media.search",
      capability: "observation.media",
      available: false,
      backend: "workflow-extension-ipc",
      guarantee: "none",
      unavailableReason: "media observation is unavailable",
    });
  });
});
