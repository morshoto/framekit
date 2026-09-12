import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  FinalCutConnectionManager,
  FinalCutLiveAdapter,
  FinalCutSessionAdapter,
  type FinalCutLiveRequest,
  type FinalCutLiveResponse,
} from "@framekit/final-cut";
import type { ProjectSnapshot, RuntimeCapabilities } from "@framekit/runtime";
import { AgentVideoRuntime, withCapabilityFamilies } from "@framekit/runtime";
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
    projectCatalogRead: false,
    projectSelection: false,
  },
  analyzers: {
    speechTranscribe: false,
    speechVad: false,
    audioLoudness: false,
    visualTrack: false,
  },
};

const metadataIdentity = {
  name: "Final Cut Pro",
  version: "test",
  backend: "workflow-extension-ipc",
};

const unavailableCanonicalRead = {
  available: false,
  backend: "workflow-extension-ipc",
  guarantee: "none",
  unavailableReason: "canonical timeline reads are unavailable",
};

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { text?: unknown } | undefined;
  assert.equal(typeof first?.text, "string");
  return first?.text as string;
}

function metadataResponse(request: FinalCutLiveRequest): FinalCutLiveResponse {
  return {
    version: 1,
    id: request.id,
    ok: true,
    result: {
      identity: metadataIdentity,
      capabilities: metadataOnlyCapabilities,
    },
  };
}

test("metadata-only project inspection has one capability contract across MCP surfaces", async () => {
  let snapshotCalls = 0;
  const live = new FinalCutLiveAdapter({
    request: async (request) => {
      if (request.method === "snapshot") snapshotCalls += 1;
      return metadataResponse(request);
    },
  });
  const runtime = new AgentVideoRuntime(new FinalCutSessionAdapter({ live }));
  const connection = new FinalCutConnectionManager({
    headless: true,
    probe: async () => ({ identity: metadataIdentity, capabilities: metadataOnlyCapabilities }),
  });
  await connection.ensureConnected();
  const server = createMcpServer(runtime, { connectionStatus: () => connection.getStatus() });
  const client = new Client({ name: "project-inspect-capability-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const status = JSON.parse(textFrom(await client.callTool({ name: "connection.status", arguments: {} })));
    const editor = JSON.parse(textFrom(await client.callTool({ name: "editor.inspect", arguments: {} })));
    const statusRead = status.capabilities.families.canonicalDocument.read;
    const editorRead = editor.capabilities.families.canonicalDocument.read;

    assert.equal(status.capabilities.editor.projectRead, false);
    assert.equal(editor.capabilities.editor.projectRead, false);
    assert.deepEqual(statusRead, editorRead);
    assert.deepEqual(editorRead, unavailableCanonicalRead);

    const project = await client.callTool({ name: "project.inspect", arguments: {} });
    assert.equal(project.isError, true);
    const projectError = JSON.parse(textFrom(project)) as {
      code?: unknown;
      message?: unknown;
      operation?: unknown;
      capability?: unknown;
    };
    assert.deepEqual(projectError, {
      code: "CAPABILITY_UNAVAILABLE",
      message: "CAPABILITY_UNAVAILABLE: canonical timeline reads are unavailable",
      operation: "canonicalDocument.read",
      capability: unavailableCanonicalRead,
    });
    assert.equal(snapshotCalls, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("project inspection rejects before invoking an unavailable snapshot provider", async () => {
  const adapter = new InMemoryEditorAdapter({
    projectId: "metadata-project",
    projectName: "Metadata-only",
    timelineId: "metadata-sequence",
    timelineName: "Main",
    clips: [],
  });
  const readProject = adapter.readProject.bind(adapter);
  let readCalls = 0;
  adapter.getCapabilities = async () => metadataOnlyCapabilities;
  adapter.readProject = async (): Promise<ProjectSnapshot> => {
    readCalls += 1;
    return readProject();
  };

  await assert.rejects(new AgentVideoRuntime(adapter).inspectProject(), (error: unknown) => {
    assert.ok(error instanceof Error);
    const value = error as Error & {
      code?: unknown;
      operation?: unknown;
      capability?: unknown;
    };
    assert.equal(value.code, "CAPABILITY_UNAVAILABLE");
    assert.equal(value.operation, "canonicalDocument.read");
    assert.deepEqual(value.capability, unavailableCanonicalRead);
    return true;
  });
  assert.equal(readCalls, 0);
});

test("metadata-only capability normalization remains explicit", () => {
  const capabilities = withCapabilityFamilies(metadataOnlyCapabilities, { backend: metadataIdentity.backend });

  assert.equal(capabilities.editor.canonicalTimelineMode, "metadata-only");
  assert.equal(capabilities.families.canonicalDocument.read.available, false);
});
