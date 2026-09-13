import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createDisposableNativeOperationSession,
  DisposableNativeEditWorkflow,
  NativeOperationSession,
  type NativeOperationSessionEvidence,
  type NativeOperationSessionExecutor,
  type NativeOperationSessionRequest,
  type NativeOperationReadinessResult,
} from "@framekit/final-cut";
import type { ContextRevision } from "@framekit/runtime";

const baseRevision: ContextRevision = {
  id: "revision-1",
  sequence: 1,
  timestamp: "2026-09-13T00:00:00.000Z",
};

const ready: NativeOperationReadinessResult = {
  readiness: {
    state: "ready",
    nextAction: "none",
    retryable: false,
    frontmost: true,
    timelineFocus: true,
    selectedTarget: true,
    overlay: "clear",
    permission: "granted",
    undo: "available",
    guidance: "Native Final Cut readiness is available",
  },
};

const waiting: NativeOperationReadinessResult = {
  readiness: {
    state: "unavailable",
    nextAction: "retry",
    retryable: true,
    firstMissing: "frontmost",
    frontmost: false,
    timelineFocus: false,
    selectedTarget: true,
    overlay: "clear",
    permission: "granted",
    undo: "unknown",
    guidance: "Bring Final Cut Pro to the front and retry",
  },
  error: {
    code: "FINAL_CUT_NATIVE_NOT_FRONTMOST",
    message: "Final Cut's timeline window must be frontmost",
  },
};

const evidence: NativeOperationSessionEvidence = {
  readback: {
    status: "verified",
    revision: { id: "revision-2", sequence: 2, timestamp: "2026-09-13T00:00:01.000Z" },
    detail: "Canonical read-after-write observed the requested target",
  },
  diff: { added: 0, removed: 0, modified: 1 },
  verification: {
    status: "verified",
    checks: [{ name: "target-renamed", passed: true, detail: "Observed the requested name" }],
  },
  rollback: {
    status: "available",
    operationId: "native-operation-1",
    detail: "Final Cut Undo is available for this operation",
  },
};

function request(overrides: Partial<NativeOperationSessionRequest> = {}): NativeOperationSessionRequest {
  return {
    operation: "disposable.rename-clip",
    previewToken: "preview-1",
    projectId: "project-1",
    sequenceId: "sequence-1",
    targetIdentity: "clip-1",
    baseRevision,
    idempotencyKey: "request-1",
    ...overrides,
  };
}

function executor(overrides: Partial<NativeOperationSessionExecutor> = {}): NativeOperationSessionExecutor {
  return {
    checkReadiness: async () => ready,
    revalidate: async () => {},
    execute: async (_request, context) => {
      context.markMutationStarted();
      return { outcome: "completed", evidence };
    },
    ...overrides,
  };
}

async function eventually(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test("native session accepts unavailable work without executing or blocking", async () => {
  let executeCalls = 0;
  const session = new NativeOperationSession({
    executor: executor({
      checkReadiness: async () => waiting,
      execute: async (...args) => {
        executeCalls += 1;
        return executor().execute(...args);
      },
    }),
  });

  const accepted = await session.submit(request());

  assert.equal(accepted.state, "planned");
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.completed, false);
  await eventually(() => session.status(accepted.jobId).state === "waiting_for_final_cut", "job did not become waitable");

  const status = session.status(accepted.jobId);
  assert.equal(status.readiness?.state, "unavailable");
  assert.equal(status.readiness?.firstMissing, "frontmost");
  assert.equal(status.error?.code, "FINAL_CUT_NATIVE_NOT_FRONTMOST");
  assert.equal(status.error?.retryable, true);
  assert.equal(executeCalls, 0);
});

test("native session completes with separate verification and restoration facts", async () => {
  const session = new NativeOperationSession({ executor: executor() });
  const accepted = await session.submit(request());

  await eventually(() => session.status(accepted.jobId).state === "completed", "job did not complete");
  const status = session.status(accepted.jobId);

  assert.equal(status.accepted, true);
  assert.equal(status.completed, true);
  assert.equal(status.verified, true);
  assert.equal(status.restored, false);
  assert.deepEqual(status.evidence?.readback.revision, { id: "revision-2", sequence: 2, timestamp: "2026-09-13T00:00:01.000Z" });
  assert.deepEqual(status.evidence?.diff, { added: 0, removed: 0, modified: 1 });
  assert.equal(status.evidence?.rollback.status, "available");
});

test("native session rejects stale bindings before native execution", async () => {
  let executeCalls = 0;
  const session = new NativeOperationSession({
    executor: executor({
      revalidate: async () => {
        throw new Error("STALE_CONTEXT: preview revision changed");
      },
      execute: async (...args) => {
        executeCalls += 1;
        return executor().execute(...args);
      },
    }),
  });
  const accepted = await session.submit(request());

  await eventually(() => session.status(accepted.jobId).state === "failed", "stale job did not fail");
  const status = session.status(accepted.jobId);
  assert.equal(status.error?.code, "STALE_CONTEXT");
  assert.equal(status.error?.retryable, false);
  assert.equal(executeCalls, 0);
});

test("native session makes idempotent submissions return the original job", async () => {
  const session = new NativeOperationSession({ executor: executor() });
  const first = await session.submit(request());
  const second = await session.submit(request());

  assert.equal(second.jobId, first.jobId);
  await assert.rejects(
    session.submit(request({ previewToken: "different-preview" })),
    /NATIVE_OPERATION_IDEMPOTENCY_CONFLICT/,
  );
});

test("native session retries a waiting job explicitly", async () => {
  let readinessCalls = 0;
  let executeCalls = 0;
  const session = new NativeOperationSession({
    executor: executor({
      checkReadiness: async () => {
        readinessCalls += 1;
        return readinessCalls === 1 ? waiting : ready;
      },
      execute: async (...args) => {
        executeCalls += 1;
        return executor().execute(...args);
      },
    }),
  });
  const accepted = await session.submit(request());
  await eventually(() => session.status(accepted.jobId).state === "waiting_for_final_cut", "job did not wait");

  const retried = await session.retry(accepted.jobId);
  assert.equal(retried.state, "planned");
  await eventually(() => session.status(accepted.jobId).state === "completed", "retried job did not complete");
  assert.equal(readinessCalls, 2);
  assert.equal(executeCalls, 1);
});

test("native session retries a transient native failure after execution begins", async () => {
  let executeCalls = 0;
  const session = new NativeOperationSession({
    executor: executor({
      execute: async (...args) => {
        executeCalls += 1;
        if (executeCalls === 1) throw new Error("FINAL_CUT_NATIVE_NOT_FRONTMOST: Final Cut lost focus");
        return executor().execute(...args);
      },
    }),
  });
  const accepted = await session.submit(request());

  await eventually(() => session.status(accepted.jobId).state === "waiting_for_final_cut", "transient failure did not become retryable");
  await session.retry(accepted.jobId);
  await eventually(() => session.status(accepted.jobId).state === "completed", "transient retry did not complete");
  assert.equal(session.status(accepted.jobId).error, undefined);
  assert.equal(executeCalls, 2);
});

test("native session expires a waiting job before retry", async () => {
  let now = 1_000;
  let executeCalls = 0;
  const session = new NativeOperationSession({
    now: () => now,
    jobTtlMs: 100,
    executor: executor({
      checkReadiness: async () => waiting,
      execute: async (...args) => {
        executeCalls += 1;
        return executor().execute(...args);
      },
    }),
  });
  const accepted = await session.submit(request());
  await eventually(() => session.status(accepted.jobId).state === "waiting_for_final_cut", "job did not wait");
  now += 101;

  const expired = await session.retry(accepted.jobId);
  assert.equal(expired.state, "failed");
  assert.equal(expired.error?.code, "NATIVE_OPERATION_SESSION_EXPIRED");
  assert.equal(executeCalls, 0);
});

test("native session reports expiry when polling a waiting job", async () => {
  let now = 1_000;
  const session = new NativeOperationSession({
    now: () => now,
    jobTtlMs: 100,
    executor: executor({ checkReadiness: async () => waiting }),
  });
  const accepted = await session.submit(request());
  await eventually(() => session.status(accepted.jobId).state === "waiting_for_final_cut", "job did not wait");
  now += 101;

  const expired = session.status(accepted.jobId);
  assert.equal(expired.state, "failed");
  assert.equal(expired.error?.code, "NATIVE_OPERATION_SESSION_EXPIRED");
});

test("native session retains expired jobs before pruning status and idempotency", async () => {
  let now = 1_000;
  const session = new NativeOperationSession({
    now: () => now,
    jobTtlMs: 100,
    jobRetentionMs: 50,
    executor: executor({ checkReadiness: async () => waiting }),
  });
  const accepted = await session.submit(request());
  await eventually(() => session.status(accepted.jobId).state === "waiting_for_final_cut", "job did not wait");

  now = 1_101;
  const expired = session.status(accepted.jobId);
  assert.equal(expired.state, "failed");
  assert.equal((await session.submit(request())).jobId, accepted.jobId);

  now = 1_140;
  assert.equal(session.status(accepted.jobId).jobId, accepted.jobId);
  assert.equal((await session.submit(request())).jobId, accepted.jobId);

  now = 1_151;
  assert.throws(() => session.status(accepted.jobId), /NATIVE_OPERATION_SESSION_NOT_FOUND/);
  const replacement = await session.submit(request());
  assert.notEqual(replacement.jobId, accepted.jobId);
});

test("native session sanitizes arbitrary executor diagnostics", async () => {
  const session = new NativeOperationSession({
    executor: executor({
      execute: async () => {
        throw new Error("PERMISSION_DENIED: credential=secret path=/Users/private/interview.mov");
      },
    }),
  });
  const accepted = await session.submit(request());

  await eventually(() => session.status(accepted.jobId).state === "failed", "unsafe executor error did not fail");
  const status = session.status(accepted.jobId);
  assert.equal(status.error?.code, "PERMISSION_DENIED");
  assert.doesNotMatch(status.error?.message ?? "", /secret|interview\.mov|\/Users\/private/);
  assert.match(status.error?.message ?? "", /native operation failed/i);
});

test("native session cancels waiting work without invoking the executor", async () => {
  let executeCalls = 0;
  const session = new NativeOperationSession({
    executor: executor({
      checkReadiness: async () => waiting,
      execute: async (...args) => {
        executeCalls += 1;
        return executor().execute(...args);
      },
    }),
  });
  const accepted = await session.submit(request());
  await eventually(() => session.status(accepted.jobId).state === "waiting_for_final_cut", "job did not wait");

  const cancelled = await session.cancel(accepted.jobId);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.completed, false);
  assert.equal(executeCalls, 0);
});

test("native session reports recovery-required cancellation after mutation starts", async () => {
  const session = new NativeOperationSession({
    executor: executor({
      execute: async (_request, context) => {
        context.markMutationStarted();
        await new Promise<never>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(new Error("FINAL_CUT_NATIVE_CANCELLED: request was cancelled")), { once: true });
        });
        throw new Error("unreachable");
      },
    }),
  });
  const accepted = await session.submit(request());
  await eventually(() => session.status(accepted.jobId).state === "executing", "job did not execute");

  await session.cancel(accepted.jobId);
  await eventually(() => session.status(accepted.jobId).state === "failed", "cancelled mutation did not fail closed");
  const status = session.status(accepted.jobId);
  assert.equal(status.error?.code, "NATIVE_OPERATION_CANCELLATION_REQUIRES_RECOVERY");
  assert.equal(status.error?.recovery, "required");
});

test("native session fails closed on an unverifiable completed result", async () => {
  const unverifiedEvidence = structuredClone(evidence);
  unverifiedEvidence.readback.status = "unverified";
  unverifiedEvidence.verification.status = "failed";
  const session = new NativeOperationSession({
    executor: executor({
      execute: async (_request, context) => {
        context.markMutationStarted();
        return { outcome: "completed", evidence: unverifiedEvidence };
      },
    }),
  });
  const accepted = await session.submit(request());

  await eventually(() => session.status(accepted.jobId).state === "failed", "unverifiable result did not fail closed");
  const status = session.status(accepted.jobId);
  assert.equal(status.completed, false);
  assert.equal(status.verified, false);
  assert.equal(status.error?.code, "NATIVE_OPERATION_UNVERIFIED_RESULT");
  assert.equal(status.error?.recovery, "required");
});

test("disposable native session retries readiness and exposes sanitized canonical evidence", async () => {
  const state = createDisposableState();
  const workflow = createDisposableWorkflow(state);
  const preview = await workflow.preview({ clipId: "clip-1", name: "Interview Clean" });
  state.nativeReady = false;
  const session = createDisposableNativeOperationSession({ workflow, native: state.native });

  const accepted = await session.submit({
    operation: "disposable.rename-clip",
    previewToken: preview.previewToken,
    projectId: preview.projectId,
    sequenceId: preview.sequenceId,
    targetIdentity: preview.targetIdentity,
    baseRevision: preview.baseRevision,
    idempotencyKey: "disposable-request-1",
  });
  await eventually(() => session.status(accepted.jobId).state === "waiting_for_final_cut", "disposable job did not wait");
  assert.equal(state.nativeEditCalls, 0);

  state.nativeReady = true;
  await session.retry(accepted.jobId);
  await eventually(() => session.status(accepted.jobId).state === "completed", "disposable job did not complete");
  const status = session.status(accepted.jobId);
  assert.deepEqual(status.evidence?.diff, { added: 0, removed: 0, modified: 1 });
  assert.equal(status.evidence?.readback.status, "verified");
  assert.equal(status.evidence?.rollback.status, "available");
  assert.equal(status.evidence?.verification.status, "verified");
  assert.doesNotMatch(JSON.stringify(status), /interview\.mov/);
});

test("disposable native session exposes verified restoration after a failed mutation", async () => {
  const state = createDisposableState();
  state.canonicalAfterEditName = "Unexpected result";
  const workflow = createDisposableWorkflow(state);
  const preview = await workflow.preview({ clipId: "clip-1", name: "Interview Clean" });
  const session = createDisposableNativeOperationSession({ workflow, native: state.native });
  const accepted = await session.submit({
    operation: "disposable.rename-clip",
    previewToken: preview.previewToken,
    projectId: preview.projectId,
    sequenceId: preview.sequenceId,
    targetIdentity: preview.targetIdentity,
    baseRevision: preview.baseRevision,
    idempotencyKey: "disposable-request-rollback",
  });

  await eventually(() => session.status(accepted.jobId).state === "rolled_back", "failed mutation did not roll back");
  const status = session.status(accepted.jobId);
  assert.equal(status.completed, false);
  assert.equal(status.verified, false);
  assert.equal(status.restored, true);
  assert.equal(status.evidence?.verification.status, "failed");
  assert.equal(status.evidence?.rollback.status, "restored");
  assert.equal(state.nativeUndoCalls, 1);
});

test("disposable native session rejects a changed preview binding before native mutation", async () => {
  const state = createDisposableState();
  const workflow = createDisposableWorkflow(state);
  const preview = await workflow.preview({ clipId: "clip-1", name: "Interview Clean" });
  const session = createDisposableNativeOperationSession({ workflow, native: state.native });
  const accepted = await session.submit({
    operation: "disposable.rename-clip",
    previewToken: preview.previewToken,
    projectId: preview.projectId,
    sequenceId: preview.sequenceId,
    targetIdentity: "different-target",
    baseRevision: preview.baseRevision,
    idempotencyKey: "disposable-request-2",
  });

  await eventually(() => session.status(accepted.jobId).state === "failed", "changed binding did not fail");
  assert.equal(session.status(accepted.jobId).error?.code, "TARGET_MISMATCH");
  assert.equal(state.nativeEditCalls, 0);
});

test("disposable native preview binds the native target identity", async () => {
  const state = createDisposableState();
  const workflow = createDisposableWorkflow(state);
  const preview = await workflow.preview({ clipId: "clip-1", name: "Interview Clean" });

  assert.equal(preview.targetIdentity, "native-target-1");
});

test("disposable native execution rejects a missing observed identity", async () => {
  const state = createDisposableState();
  const workflow = createDisposableWorkflow(state);
  const preview = await workflow.preview({ clipId: "clip-1", name: "Interview Clean" });

  state.nativeTargetIdentity = null;
  await assert.rejects(workflow.execute(preview.previewToken), /TARGET_MISMATCH/);
  assert.equal(state.nativeEditCalls, 0);
});

test("native operation session documentation names the contract and safety boundary", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const tools = await readFile(join(here, "../../docs/mcp/tools.md"), "utf8");
  const live = await readFile(join(here, "../../docs/mcp/final-cut-live.md"), "utf8");

  for (const tool of [
    "editor.native.operation.submit",
    "editor.native.operation.status",
    "editor.native.operation.retry",
    "editor.native.operation.cancel",
  ]) assert.match(tools, new RegExp("\\\\| `" + tool + "` \\\\|"));
  assert.match(live, /waiting_for_final_cut/);
  assert.match(live, /idempotencyKey/);
  assert.match(live, /do not survive MCP process restart/);
});

interface DisposableState {
  snapshot: ReturnType<typeof disposableSnapshot>;
  nativeReady: boolean;
  nativeTargetIdentity: string | null;
  targetClipId: string;
  selectedName: string;
  canonicalAfterEditName?: string;
  nativeEditCalls: number;
  nativeUndoCalls: number;
  native: import("@framekit/final-cut").NativeFinalCutEditor;
}

function createDisposableWorkflow(state: DisposableState): DisposableNativeEditWorkflow {
  return new DisposableNativeEditWorkflow({
    native: state.native,
    readCanonicalSnapshot: async () => {
      const snapshot = structuredClone(state.snapshot);
      if (state.nativeEditCalls > state.nativeUndoCalls) {
        const target = snapshot.timeline.clips.find((clip) => clip.id === state.targetClipId);
        target!.name = state.canonicalAfterEditName ?? state.selectedName;
        snapshot.revision = { id: "rev-2", sequence: 2, timestamp: new Date(2).toISOString() };
      }
      return snapshot;
    },
    readCanonicalCapabilities: async () => ({
      editor: {
        canonicalTimelineMode: "canonical-write",
        projectRead: true,
        timelineSnapshotRead: true,
        timelineWrite: true,
        timelineArtifactWrite: false,
        readAfterWrite: true,
        incrementalChanges: true,
        rollback: true,
        assetDiscovery: false,
        liveStateRead: true,
        playheadWrite: false,
        frameCapture: false,
        projectCatalogRead: true,
        projectSelection: true,
      },
      analyzers: { speechTranscribe: false, speechVad: false, audioLoudness: false, visualTrack: false },
    }),
  });
}

function createDisposableState(): DisposableState {
  const state = {} as DisposableState;
  state.snapshot = disposableSnapshot("Interview", 1);
  state.nativeReady = true;
  state.nativeTargetIdentity = "native-target-1";
  state.targetClipId = "clip-1";
  state.selectedName = "Interview";
  state.nativeEditCalls = 0;
  state.nativeUndoCalls = 0;
  state.native = {
    capabilities: () => ({
      selectionEdit: true,
      undo: true,
      mediaLibrarySearch: false,
      mediaImport: false,
      mediaSelection: false,
      mediaAppendSelected: false,
      timelineOccurrenceLocate: false,
      bladeAtPlayhead: false,
      deleteRange: false,
      trimToDuration: false,
      mediaAppend: false,
      mediaInsert: false,
      titlePlacement: false,
      timelineFocus: true,
      requiresAccessibility: true,
      requiresFinalCutFrontmost: true,
    }),
    inspect: async () => state.nativeReady
      ? disposableNativeContext(state.selectedName, state.nativeEditCalls > 0, state.nativeTargetIdentity)
      : unavailableDisposableNativeContext(),
    edit: async (operation: Extract<import("@framekit/final-cut").NativeFinalCutEdit, { type: "rename-selected-clip" }>) => {
      state.nativeEditCalls += 1;
      state.selectedName = operation.name;
      return {
        operationId: "native-operation-1",
        operation,
        command: "Modify > Apply Custom Name",
        before: disposableNativeContext("Interview", false),
        after: disposableNativeContext(operation.name, true),
        verification: { verified: true, level: "selection-observed", detail: "Selected clip name changed" },
        undoAvailable: true,
        undoCommand: "Undo Apply Custom Name",
      };
    },
    undo: async (operationId: string) => {
      state.nativeUndoCalls += 1;
      state.selectedName = "Interview";
      return {
        operationId,
        undone: true,
        context: disposableNativeContext("Interview", false),
        verification: { verified: true, detail: "Final Cut restored the native edit's pre-operation state" },
      };
    },
  } as unknown as DisposableState["native"];
  return state;
}

function disposableSnapshot(name: string, revision: number) {
  return {
    projectId: "project-1",
    projectName: "Disposable Native",
    timeline: {
      id: "sequence-1",
      name: "Main",
      duration: 10,
      durationTime: { value: "10", timescale: "1" },
      clips: [{ id: "clip-1", mediaId: "media-1", name, start: 0, duration: 10, track: 1, startTime: { value: "0", timescale: "1" }, durationTime: { value: "10", timescale: "1" } }],
      storyElements: [{ id: "clip-1", kind: "asset-clip", start: 0, duration: 10, lane: 1, mediaId: "media-1" }],
      markers: [],
      captions: [],
    },
    media: [{ mediaId: "media-1", source: "interview.mov" }],
    revision: { id: `rev-${revision}`, sequence: revision, timestamp: new Date(revision).toISOString() },
  };
}

function disposableNativeContext(name: string, edited: boolean, identity: string | null = "native-target-1"): import("@framekit/final-cut").NativeFinalCutContext {
  return {
    available: true,
    application: "Final Cut Pro",
    frontmost: true,
    frontWindow: "Final Cut Pro",
    timelineWindowAvailable: true,
    timelineFocused: true,
    focusTarget: "timeline",
    project: "Disposable Native",
    sequence: "Main",
    target: { kind: "selected-clip", name, ...(identity ? { identity } : {}) },
    bladeAvailable: false,
    undoAvailable: edited,
    readiness: {
      state: "ready",
      nextAction: "none",
      retryable: false,
      frontmost: true,
      timelineFocus: true,
      selectedTarget: true,
      overlay: "unknown",
      permission: "granted",
      undo: edited ? "available" : "unavailable",
      guidance: "Native Final Cut readiness is available",
    },
    ...(edited ? { undoCommand: "Undo Apply Custom Name" } : {}),
  };
}

function unavailableDisposableNativeContext(): import("@framekit/final-cut").NativeFinalCutContext {
  return {
    ...disposableNativeContext("Interview", false),
    available: false,
    frontmost: false,
    timelineFocused: false,
    readiness: {
      ...disposableNativeContext("Interview", false).readiness,
      state: "unavailable",
      nextAction: "retry",
      retryable: true,
      firstMissing: "frontmost",
      frontmost: false,
      timelineFocus: false,
      guidance: "Bring Final Cut Pro to the front and retry",
    },
    error: { code: "FINAL_CUT_NATIVE_NOT_FRONTMOST", message: "Final Cut's timeline window must be frontmost", state: "unavailable", retryable: true },
  };
}
