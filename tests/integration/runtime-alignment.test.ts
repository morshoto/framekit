import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  FinalCutProjectPublisher,
  FinalCutVideoExporter,
  NativeOperationSession,
} from "@framekit/final-cut";
import { FinalCutLiveAdapter, FinalCutSessionAdapter } from "@framekit/final-cut";
import type { NativeFinalCutEditor } from "@framekit/final-cut";
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

const extensionFingerprint = { version: "0.1.7", commit: "test-commit" };

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { text?: unknown } | undefined;
  assert.ok(first);
  assert.equal(typeof first?.text, "string");
  return first.text as string;
}

function metadataOnlyRuntime(fingerprint = extensionFingerprint): AgentVideoRuntime {
  const live = new FinalCutLiveAdapter({
    request: async (request) => ({
      version: 1,
      id: request.id,
      ok: true,
      result: {
        identity: {
          name: "Final Cut Pro",
          version: "10.7.1",
          backend: "workflow-extension-ipc",
          buildFingerprint: fingerprint,
        },
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
  overrides: {
    buildFingerprint?: { version: string; commit: string };
    requireBuildAlignment?: boolean;
    validationCommit?: string;
    includeConnectionCapabilities?: boolean;
    nativeEditor?: NativeFinalCutEditor;
    nativeOperationSession?: Pick<NativeOperationSession, "submit" | "status" | "retry" | "cancel">;
    projectPublisher?: FinalCutProjectPublisher;
    videoExporter?: FinalCutVideoExporter;
  } = {},
): Promise<void> {
  const server = createMcpServer(runtime, {
    processMode: "headless",
    buildFingerprint: overrides.buildFingerprint ?? { version: "0.1.7", commit: "test-commit" },
    requireBuildAlignment: overrides.requireBuildAlignment,
    validationCommit: overrides.validationCommit,
    nativeEditor: overrides.nativeEditor,
    nativeOperationSession: overrides.nativeOperationSession,
    projectPublisher: overrides.projectPublisher,
    videoExporter: overrides.videoExporter,
    connectionStatus: () => ({
      state: "ready",
      editorDetected: true,
      extensionInstalled: true,
      identity: {
        name: "Final Cut Pro",
        version: "10.7.1",
        backend: "workflow-extension-ipc",
        buildFingerprint: extensionFingerprint,
      },
      ...(overrides.includeConnectionCapabilities === false ? {} : { capabilities: bridgeCapabilities }),
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
    assert.deepEqual(status.identity.buildFingerprint, extensionFingerprint);
    assert.deepEqual(editor.identity.buildFingerprint, extensionFingerprint);
    assert.equal(status.preflight.buildAlignment?.status, "matched");
  });
});

test("required local alignment fails clearly for a stale extension", async () => {
  await withClient(metadataOnlyRuntime(), async (client) => {
    const status = JSON.parse(textFrom(await client.callTool({ name: "connection.status", arguments: {} })));

    assert.equal(status.state, "unavailable");
    assert.equal(status.lastError?.code, "FRAMEKIT_BUILD_ALIGNMENT_MISMATCH");
    assert.match(status.lastError?.message ?? "", /extension commit test-commit does not match runtime commit intended-commit/);
    assert.equal(status.preflight, undefined);
  }, {
    buildFingerprint: { version: "0.1.7", commit: "intended-commit" },
    requireBuildAlignment: true,
    validationCommit: "intended-commit",
  });
});

test("required local alignment fails clearly for a different extension version", async () => {
  await withClient(metadataOnlyRuntime({ version: "0.1.6", commit: "test-commit" }), async (client) => {
    const status = JSON.parse(textFrom(await client.callTool({ name: "connection.status", arguments: {} })));

    assert.equal(status.state, "unavailable");
    assert.equal(status.lastError?.code, "FRAMEKIT_BUILD_ALIGNMENT_MISMATCH");
    assert.match(status.lastError?.message ?? "", /extension version 0\.1\.6 does not match runtime version 0\.1\.7/);
    assert.equal(status.preflight, undefined);
  }, { requireBuildAlignment: true });
});

test("required local alignment blocks direct native edits when the extension is stale", async () => {
  let editCalls = 0;
  const nativeEditor = {
    edit: async () => {
      editCalls += 1;
      return { status: "edited" };
    },
  } as unknown as NativeFinalCutEditor;

  await withClient(metadataOnlyRuntime(), async (client) => {
    const result = await client.callTool({
      name: "editor.native.edit",
      arguments: { type: "add-marker-at-playhead", name: "Review" },
    });

    assert.equal(result.isError, true);
    assert.match(textFrom(result), /FRAMEKIT_BUILD_ALIGNMENT_MISMATCH/);
    assert.equal(editCalls, 0);
  }, {
    requireBuildAlignment: true,
    validationCommit: "intended-commit",
    nativeEditor,
  });
});

test("required local alignment blocks native publishing and export providers", async () => {
  let publishCalls = 0;
  let exportCalls = 0;
  const projectPublisher = {
    isAvailable: () => true,
    executionMode: () => "background-capable",
    getPublishJob: () => undefined,
    executePublishJob: async () => {
      publishCalls += 1;
      return { state: "completed" };
    },
  } as unknown as FinalCutProjectPublisher;
  const videoExporter = {
    isAvailable: () => true,
    exportVideo: async () => {
      exportCalls += 1;
      return { verified: true };
    },
  } as unknown as FinalCutVideoExporter;

  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Alignment Guard Test",
    timelineId: "timeline-1",
    timelineName: "Main",
    clips: [],
  }));

  await withClient(runtime, async (client) => {
    const publish = await client.callTool({
      name: "artifact.publish.execute",
      arguments: { jobId: "job-1", confirm: true },
    });
    assert.equal(publish.isError, true);
    assert.match(textFrom(publish), /FRAMEKIT_BUILD_ALIGNMENT_MISMATCH/);
    assert.equal(publishCalls, 0);

    const exportResult = await client.callTool({
      name: "timeline.export",
      arguments: { outputPath: "/tmp/final.mp4", preset: "master" },
    });
    assert.equal(exportResult.isError, true);
    assert.match(textFrom(exportResult), /FRAMEKIT_BUILD_ALIGNMENT_MISMATCH/);
    assert.equal(exportCalls, 0);
  }, {
    requireBuildAlignment: true,
    validationCommit: "intended-commit",
    includeConnectionCapabilities: false,
    projectPublisher,
    videoExporter,
  });
});

test("required local alignment serializes native operation status results", async () => {
  const job = {
    jobId: "job-1",
    operation: "replace-clip",
    state: "waiting_for_final_cut",
    accepted: true,
    completed: false,
    verified: false,
    restored: false,
  };
  const nativeOperationSession = {
    status: () => job,
  } as unknown as Pick<NativeOperationSession, "submit" | "status" | "retry" | "cancel">;

  await withClient(metadataOnlyRuntime(), async (client) => {
    const result = JSON.parse(textFrom(await client.callTool({
      name: "editor.native.operation.status",
      arguments: { jobId: "job-1" },
    })));
    assert.deepEqual(result, job);
  }, {
    requireBuildAlignment: true,
    nativeOperationSession,
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
      backend: "workflow-extension-ipc",
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
