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

function metadataOnlyRuntime(
  fingerprint: { version: string; commit: string } | null = extensionFingerprint,
): AgentVideoRuntime {
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
          ...(fingerprint ? { buildFingerprint: fingerprint } : {}),
        },
        capabilities: bridgeCapabilities,
      },
    }),
  });
  return new AgentVideoRuntime(new FinalCutSessionAdapter({ live }));
}

function handoffPublisher(jobs: Record<string, unknown> = {}) {
  return {
    inspectReadiness: () => ({
      available: true,
      targetBindingAvailable: true,
      reasons: [],
    }),
    getPublishJob: (jobId: string) => {
      const job = jobs[jobId];
      if (!job) throw new Error(`FINAL_CUT_PUBLISH_JOB_NOT_FOUND: ${jobId}`);
      return job;
    },
  } as unknown as FinalCutProjectPublisher;
}

function fcpxmlWithLiveRuntime(): AgentVideoRuntime {
  const snapshot = new InMemoryEditorAdapter({
    projectId: "fcpxml-project",
    projectName: "FCPXML Project",
    timelineId: "fcpxml-sequence",
    timelineName: "Main",
    clips: [],
  });
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
          buildFingerprint: extensionFingerprint,
        },
        capabilities: bridgeCapabilities,
      },
    }),
  });
  return new AgentVideoRuntime(new FinalCutSessionAdapter({ snapshot, mutation: snapshot, live }));
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

test("FCPXML and live sessions retain the Workflow Extension build fingerprint", async () => {
  await withClient(fcpxmlWithLiveRuntime(), async (client) => {
    const status = JSON.parse(textFrom(await client.callTool({ name: "connection.status", arguments: {} })));
    const editor = JSON.parse(textFrom(await client.callTool({ name: "editor.inspect", arguments: {} })));

    assert.deepEqual(status.identity.buildFingerprint, extensionFingerprint);
    assert.deepEqual(editor.identity.buildFingerprint, extensionFingerprint);
    assert.equal(status.preflight.buildAlignment?.status, "matched");
    assert.equal(editor.preflight.buildAlignment?.status, "matched");
  });
});

test("native handoff readiness requires target binding and a matching extension", async () => {
  await withClient(metadataOnlyRuntime(), async (client) => {
    const readiness = JSON.parse(textFrom(await client.callTool({
      name: "editor.native.handoff.readiness",
      arguments: {},
    })));

    assert.equal(readiness.status, "ready");
    assert.deepEqual(readiness.reasons, []);
    assert.deepEqual(readiness.targetBinding, { available: true, guarantee: "native-readback" });
    assert.equal(readiness.buildAlignment.status, "matched");
    assert.equal("createdTarget" in readiness, false);
    const editor = JSON.parse(textFrom(await client.callTool({ name: "editor.inspect", arguments: {} })));
    assert.equal(editor.preflight.nativeHandoffReadiness.status, "ready");
  }, { projectPublisher: handoffPublisher() });
});

test("native handoff readiness reports a missing target-binding provider", async () => {
  const projectPublisher = {
    inspectReadiness: () => ({
      available: false,
      targetBindingAvailable: false,
      reasons: [{
        code: "FINAL_CUT_PUBLISH_TARGET_BINDING_UNAVAILABLE",
        message: "The native library catalog cannot bind a published artifact to a created target",
      }],
    }),
  } as unknown as FinalCutProjectPublisher;

  await withClient(metadataOnlyRuntime(), async (client) => {
    const readiness = JSON.parse(textFrom(await client.callTool({
      name: "editor.native.handoff.readiness",
      arguments: {},
    })));

    assert.equal(readiness.status, "blocked");
    assert.equal(readiness.targetBinding.available, false);
    assert.ok(readiness.reasons.some((reason: { code: string }) => reason.code === "FINAL_CUT_PUBLISH_TARGET_BINDING_UNAVAILABLE"));
    assert.equal("createdTarget" in readiness, false);
  }, { projectPublisher });
});

test("native handoff readiness reports an unconfigured publisher", async () => {
  await withClient(metadataOnlyRuntime(), async (client) => {
    const readiness = JSON.parse(textFrom(await client.callTool({
      name: "editor.native.handoff.readiness",
      arguments: {},
    })));

    assert.equal(readiness.status, "blocked");
    assert.deepEqual(readiness.targetBinding, { available: false, guarantee: "none" });
    assert.ok(readiness.reasons.some((reason: { code: string }) => reason.code === "FINAL_CUT_PUBLISH_PROVIDER_UNAVAILABLE"));
  });
});

test("native handoff readiness does not call native UI providers", async () => {
  let nativeCalls = 0;
  const nativeEditor = {
    capabilities: () => { nativeCalls += 1; return {}; },
    inspect: async () => { nativeCalls += 1; return { readiness: {} }; },
  } as unknown as NativeFinalCutEditor;

  await withClient(metadataOnlyRuntime(), async (client) => {
    const readiness = JSON.parse(textFrom(await client.callTool({
      name: "editor.native.handoff.readiness",
      arguments: {},
    })));
    assert.equal(readiness.status, "ready");
    assert.equal(nativeCalls, 0);
  }, { nativeEditor, projectPublisher: handoffPublisher() });
});

test("native handoff readiness reports missing and mismatched extension fingerprints", async () => {
  for (const scenario of [
    {
      runtime: metadataOnlyRuntime(null),
      status: "missing",
      reason: "FRAMEKIT_BUILD_ALIGNMENT_MISSING",
    },
    {
      runtime: metadataOnlyRuntime({ version: "0.1.6", commit: "test-commit" }),
      status: "mismatched",
      reason: "FRAMEKIT_BUILD_ALIGNMENT_MISMATCH",
    },
  ]) {
    await withClient(scenario.runtime, async (client) => {
      const readiness = JSON.parse(textFrom(await client.callTool({
        name: "editor.native.handoff.readiness",
        arguments: {},
      })));

      assert.equal(readiness.status, "blocked");
      assert.equal(readiness.buildAlignment.status, scenario.status);
      assert.ok(readiness.reasons.some((reason: { code: string }) => reason.code === scenario.reason));
    }, { projectPublisher: handoffPublisher() });
  }
});

test("native handoff readiness withholds targets until a publish job is verified", async () => {
  const createdTarget = {
    kind: "editor.project",
    projectId: "native-project",
    sequenceId: "native-sequence",
    projectName: "Published Project",
    sequenceName: "Main",
  };
  const projectPublisher = handoffPublisher({
    pending: {
      jobId: "pending",
      state: "verification-pending",
      nextAction: "retry",
      retryable: true,
      createdTarget: undefined,
      result: undefined,
      error: { code: "FINAL_CUT_PUBLISH_TARGET_PENDING", message: "Native readback is pending" },
    },
    verified: {
      jobId: "verified",
      state: "verified",
      nextAction: "none",
      retryable: false,
      createdTarget,
      result: { verified: true, createdTarget },
    },
  });

  await withClient(metadataOnlyRuntime(), async (client) => {
    const pending = JSON.parse(textFrom(await client.callTool({
      name: "editor.native.handoff.readiness",
      arguments: { publishJobId: "pending" },
    })));
    assert.equal(pending.status, "blocked");
    assert.equal(pending.publish.state, "verification-pending");
    assert.equal("createdTarget" in pending, false);
    assert.ok(pending.reasons.some((reason: { code: string }) => reason.code === "FINAL_CUT_PUBLISH_TARGET_UNVERIFIED"));

    const verified = JSON.parse(textFrom(await client.callTool({
      name: "editor.native.handoff.readiness",
      arguments: { publishJobId: "verified" },
    })));
    assert.equal(verified.status, "verified");
    assert.equal(verified.publish.state, "verified");
    assert.deepEqual(verified.createdTarget, createdTarget);
    assert.deepEqual(verified.reasons, []);
  }, { projectPublisher });
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
