import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  FinalCutVideoExporter,
  NativeOperationSession,
} from "@framekit/final-cut";
import {
  FcpxmlDocumentAdapter,
  FinalCutLiveAdapter,
  FinalCutProjectPublisher,
  FinalCutSessionAdapter,
} from "@framekit/final-cut";
import type { NativeFinalCutEditor } from "@framekit/final-cut";
import type { RuntimeCapabilities } from "@framekit/runtime";
import { AgentVideoRuntime, createTimelineIrFromProjectSnapshot } from "@framekit/runtime";
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
    verifyCreatedTarget: async (jobId: string) => {
      const job = jobs[jobId] as { result?: { createdTarget?: unknown } } | undefined;
      const target = job?.result?.createdTarget;
      if (!target) throw new Error(`FINAL_CUT_PUBLISH_TARGET_REBIND_UNAVAILABLE: ${jobId}`);
      return target;
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

function targetRebindingRuntime(): AgentVideoRuntime {
  const editor = new InMemoryEditorAdapter({
    projectId: "unrelated-project",
    projectName: "Unrelated Project",
    timelineId: "unrelated-sequence",
    timelineName: "Main",
    frameDuration: { value: "1001", timescale: "24000" },
    clips: [],
    projects: [
      { id: "unrelated-project", name: "Unrelated Project", sequences: [{ id: "unrelated-sequence", name: "Main" }] },
      { id: "created-project-stable", name: "Published Project", sequences: [{ id: "created-sequence-stable", name: "Main" }] },
    ],
    projectSnapshots: [
      {
        projectId: "unrelated-project",
        projectName: "Unrelated Project",
        timelineId: "unrelated-sequence",
        timelineName: "Main",
        frameDuration: { value: "1001", timescale: "24000" },
        clips: [],
      },
      {
        projectId: "created-project-stable",
        projectName: "Published Project",
        timelineId: "created-sequence-stable",
        timelineName: "Main",
        frameDuration: { value: "1001", timescale: "24000" },
        clips: [],
      },
    ],
  });
  const getIdentity = editor.getIdentity.bind(editor);
  editor.getIdentity = async () => ({ ...await getIdentity(), buildFingerprint: extensionFingerprint });
  return new AgentVideoRuntime(editor);
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
    sessionDirectory?: string;
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
    sessionDirectory: overrides.sessionDirectory,
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

test("native handoff readiness remains inspectable with the alignment guard enabled", async () => {
  await withClient(metadataOnlyRuntime(), async (client) => {
    const editorResult = await client.callTool({ name: "editor.inspect", arguments: {} });
    assert.notEqual(editorResult.isError, true);
    const editor = JSON.parse(textFrom(editorResult));
    assert.equal(editor.preflight.nativeHandoffReadiness.status, "ready");
    assert.deepEqual(editor.preflight.nativeHandoffReadiness.reasons, []);

    const readinessResult = await client.callTool({
      name: "editor.native.handoff.readiness",
      arguments: {},
    });
    assert.notEqual(readinessResult.isError, true);
    const readiness = JSON.parse(textFrom(readinessResult));
    assert.equal(readiness.status, "ready");
    assert.equal(readiness.buildAlignment.status, "matched");
  }, {
    projectPublisher: handoffPublisher(),
    requireBuildAlignment: true,
    validationCommit: "test-commit",
  });
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

test("native handoff readiness blocks an injected publisher without readiness methods", async () => {
  await withClient(metadataOnlyRuntime(), async (client) => {
    const readiness = JSON.parse(textFrom(await client.callTool({
      name: "editor.native.handoff.readiness",
      arguments: {},
    })));

    assert.equal(readiness.status, "blocked");
    assert.deepEqual(readiness.targetBinding, { available: false, guarantee: "none" });
    assert.ok(readiness.reasons.some((reason: { code: string }) => reason.code === "FINAL_CUT_PUBLISH_TARGET_BINDING_UNAVAILABLE"));
    assert.equal("createdTarget" in readiness, false);
  }, { projectPublisher: {} as FinalCutProjectPublisher });
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

test("native handoff readiness fails closed without live target revalidation", async () => {
  const createdTarget = {
    kind: "editor.project" as const,
    projectId: "native-project",
    sequenceId: "native-sequence",
    libraryId: "native-library",
    eventId: "native-event",
    projectName: "Published Project",
    sequenceName: "Main",
  };
  const projectPublisher = {
    inspectReadiness: () => ({ available: true, targetBindingAvailable: true, reasons: [] }),
    getPublishJob: () => ({
      jobId: "verified",
      state: "verified",
      createdTarget,
      result: { verified: true, createdTarget },
    }),
  } as unknown as FinalCutProjectPublisher;

  await withClient(metadataOnlyRuntime(), async (client) => {
    const readiness = JSON.parse(textFrom(await client.callTool({
      name: "editor.native.handoff.readiness",
      arguments: { publishJobId: "verified" },
    })));
    assert.equal(readiness.status, "blocked");
    assert.equal("createdTarget" in readiness, false);
    assert.ok(readiness.reasons.some((reason: { code: string }) =>
      reason.code === "FINAL_CUT_PUBLISH_TARGET_REBIND_UNAVAILABLE"));
  }, { projectPublisher });
});

test("native handoff readiness blocks contradictory library or event identity", async () => {
  const createdTarget = {
    kind: "editor.project",
    projectId: "native-project",
    sequenceId: "native-sequence",
    libraryId: "native-library",
    eventId: "native-event",
    projectName: "Published Project",
    sequenceName: "Main",
  };
  const projectPublisher = handoffPublisher({
    "wrong-library": {
      jobId: "wrong-library",
      state: "verified",
      createdTarget,
      result: {
        verified: true,
        createdTarget: { ...createdTarget, libraryId: "other-library" },
      },
    },
    "wrong-event": {
      jobId: "wrong-event",
      state: "verified",
      createdTarget,
      result: {
        verified: true,
        createdTarget: { ...createdTarget, eventId: "other-event" },
      },
    },
  });

  await withClient(metadataOnlyRuntime(), async (client) => {
    for (const jobId of ["wrong-library", "wrong-event"]) {
      const readiness = JSON.parse(textFrom(await client.callTool({
        name: "editor.native.handoff.readiness",
        arguments: { publishJobId: jobId },
      })));

      assert.equal(readiness.status, "blocked", `${jobId} must fail closed`);
      assert.equal("createdTarget" in readiness, false);
      assert.ok(
        readiness.reasons.some((reason: { code: string }) => reason.code === "FINAL_CUT_PUBLISH_TARGET_UNVERIFIED"),
        JSON.stringify(readiness),
      );
    }
  }, { projectPublisher });
});

test("serves a verified native target after the publisher restarts", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-publisher-rebind-"));
  const sourcePath = join(directory, "approved.fcpxml");
  const source = '<fcpxml version="1.11"><library><event><project uid="source-project" name="Published Project"><sequence uid="source-sequence" name="Main" /></project></event></library></fcpxml>';
  await writeFile(sourcePath, source);

  let liveStateReads = 0;
  let targetBindingMismatch = false;
  let activeTargetMismatch = false;
  const publisherOptions = {
    enabled: true,
    sourcePath,
    publishJobDirectory: join(directory, "publish-jobs"),
    verificationTimeoutMs: 0,
    pollIntervalMs: 0,
    executor: async () => "imported",
    liveState: async () => {
      const imported = liveStateReads++ > 0;
      return {
        project: {
          id: imported
            ? activeTargetMismatch ? "changed-active-project" : "created-project-stable"
            : "existing-project",
          name: imported ? "Published Project" : "Existing Project",
        },
        sequence: {
          id: imported ? "created-sequence-stable" : "existing-sequence",
          name: imported ? "Main" : "Existing Sequence",
          startTime: { value: "0", timescale: "1" },
          duration: { value: "10", timescale: "1" },
          frameDuration: { value: "1", timescale: "24" },
        },
        revision: { id: `revision-${liveStateReads}`, sequence: liveStateReads, timestamp: new Date(0).toISOString() },
      };
    },
    targetBinding: async () => ({
      projectId: targetBindingMismatch ? "changed-project-stable" : "created-project-stable",
      sequenceId: "created-sequence-stable",
      libraryId: "created-library-stable",
      eventId: "created-event-stable",
      libraryPath: join(directory, "created-library.fcpbundle"),
    }),
    readCanonicalSnapshot: async () => new FcpxmlDocumentAdapter(sourcePath, undefined, {
      allowMissingImmutableIdsForReadback: true,
    }).readProject(),
  } as ConstructorParameters<typeof FinalCutProjectPublisher>[0] & { publishJobDirectory: string };

  try {
    const firstPublisher = new FinalCutProjectPublisher(publisherOptions);
    const prepared = await firstPublisher.preparePublish({
      sourceTransactionId: "txn-publish-rebind",
      artifactPath: sourcePath,
      artifactDigest: createHash("sha256").update(source).digest("hex"),
    });
    const verified = await firstPublisher.executePublishJob(prepared.jobId, true);
    assert.equal(verified.state, "verified");

    const restartedPublisher = new FinalCutProjectPublisher(publisherOptions);
    const reboundRuntime = targetRebindingRuntime();
    await withClient(reboundRuntime, async (client) => {
      const status = await client.callTool({
        name: "artifact.publish.status",
        arguments: { jobId: verified.jobId },
      });
      assert.equal(status.isError ?? false, false, textFrom(status));
      const restored = JSON.parse(textFrom(status));
      assert.equal(restored.state, "verified");
      assert.deepEqual(restored.createdTarget, verified.createdTarget);

      const readiness = JSON.parse(textFrom(await client.callTool({
        name: "editor.native.handoff.readiness",
        arguments: { publishJobId: verified.jobId },
      })));
      assert.equal(readiness.status, "verified");
      assert.deepEqual(readiness.createdTarget, {
        kind: "editor.project",
        projectId: "created-project-stable",
        sequenceId: "created-sequence-stable",
        libraryId: "created-library-stable",
        eventId: "created-event-stable",
        libraryPath: join(directory, "created-library.fcpbundle"),
        projectName: "Published Project",
        sequenceName: "Main",
      });

      targetBindingMismatch = true;
      const mismatchedReadiness = JSON.parse(textFrom(await client.callTool({
        name: "editor.native.handoff.readiness",
        arguments: { publishJobId: verified.jobId },
      })));
      assert.equal(mismatchedReadiness.status, "blocked");
      assert.equal("createdTarget" in mismatchedReadiness, false);
      assert.ok(mismatchedReadiness.reasons.some((reason: { code: string }) =>
        reason.code === "FINAL_CUT_PUBLISH_TARGET_REBIND_FAILED"));
      targetBindingMismatch = false;

      activeTargetMismatch = true;
      const inactiveReadiness = JSON.parse(textFrom(await client.callTool({
        name: "editor.native.handoff.readiness",
        arguments: { publishJobId: verified.jobId },
      })));
      assert.equal(inactiveReadiness.status, "blocked");
      assert.equal("createdTarget" in inactiveReadiness, false);
      assert.ok(inactiveReadiness.reasons.some((reason: { code: string }) =>
        reason.code === "FINAL_CUT_PUBLISH_TARGET_REBIND_FAILED"));
      activeTargetMismatch = false;

      const selection = JSON.parse(textFrom(await client.callTool({
        name: "project.select",
        arguments: {
          projectId: readiness.createdTarget.projectId,
          sequenceId: readiness.createdTarget.sequenceId,
        },
      })));
      assert.deepEqual(selection.observedActiveTarget, {
        projectId: "created-project-stable",
        sequenceId: "created-sequence-stable",
      });
      const canonical = await reboundRuntime.inspectProject();
      const base = createTimelineIrFromProjectSnapshot(canonical, { id: "final-cut" });
      const createdSession = JSON.parse(textFrom(await client.callTool({
        name: "session.create",
        arguments: { sessionId: "rebound-session", provider: { id: "final-cut" }, base },
      })));
      assert.equal(createdSession.document.base.project.id, "created-project-stable");
      assert.equal(createdSession.document.base.sequence.id, "created-sequence-stable");
      const restoredSession = JSON.parse(textFrom(await client.callTool({
        name: "session.inspect",
        arguments: { sessionId: "rebound-session" },
      })));
      assert.equal(restoredSession.document.base.project.id, readiness.createdTarget.projectId);
      assert.equal(restoredSession.document.base.sequence.id, readiness.createdTarget.sequenceId);
    }, { projectPublisher: restartedPublisher, sessionDirectory: join(directory, "sessions") });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

test("publish status remains readable while native handoff rebind stays alignment guarded", async () => {
  const createdTarget = {
    kind: "editor.project",
    projectId: "created-project",
    sequenceId: "created-sequence",
    libraryId: "created-library",
    eventId: "created-event",
    libraryPath: "/tmp/created-library.fcpbundle",
    projectName: "Published Project",
    sequenceName: "Main",
  };
  const job = {
    jobId: "publish-job-stored",
    state: "verified",
    createdTarget,
    result: { verified: true, createdTarget },
  };
  let rebindCalls = 0;
  const projectPublisher = {
    isAvailable: () => true,
    inspectReadiness: () => ({ available: true, targetBindingAvailable: true, reasons: [] }),
    getPublishJob: () => job,
    loadPublishJob: async () => job,
    verifyCreatedTarget: async () => {
      rebindCalls += 1;
      return createdTarget;
    },
  } as unknown as FinalCutProjectPublisher;

  await withClient(metadataOnlyRuntime(), async (client) => {
    const status = await client.callTool({
      name: "artifact.publish.status",
      arguments: { jobId: job.jobId },
    });
    assert.equal(status.isError ?? false, false, textFrom(status));
    assert.equal(JSON.parse(textFrom(status)).state, "verified");

    const readiness = JSON.parse(textFrom(await client.callTool({
      name: "editor.native.handoff.readiness",
      arguments: { publishJobId: job.jobId },
    })));
    assert.equal(readiness.status, "blocked");
    assert.ok(readiness.reasons.some((reason: { code: string }) =>
      reason.code === "FINAL_CUT_PUBLISH_TARGET_REBIND_FAILED"));
    assert.equal(rebindCalls, 0);
  }, {
    projectPublisher,
    requireBuildAlignment: true,
    validationCommit: "intended-commit",
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
