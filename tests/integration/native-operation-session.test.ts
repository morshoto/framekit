import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createDisposableNativeOperationSession,
  DisposableNativeEditWorkflow,
  NativeOperationSession,
  FileCanonicalRecoveryGuard,
  type NativeOperationSessionEvidence,
  type NativeOperationSessionExecutor,
  type NativeOperationSessionRequest,
  type NativeOperationReadinessResult,
} from "@framekit/final-cut";
import type { ContextRevision } from "@framekit/runtime";
import { recoveryBindingFromReservation, recoverVerifiedNative, verifyNativeRecovery, type RecoveryBinding, type ReceiverObservation, type CanonicalRecoveryObservation } from "../../apps/mcp-server/src/native-recovery-verification.js";

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
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
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

test("native session requires recovery when cancellation races completion", async () => {
  let resolveStarted!: () => void;
  let resolveExecution!: () => void;
  const executionStarted = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const executionCanComplete = new Promise<void>((resolve) => {
    resolveExecution = resolve;
  });
  const session = new NativeOperationSession({
    executor: executor({
      execute: async (_request, context) => {
        context.markMutationStarted();
        resolveStarted();
        await executionCanComplete;
        return { outcome: "completed", evidence };
      },
    }),
  });
  const accepted = await session.submit(request());
  await executionStarted;

  await session.cancel(accepted.jobId);
  resolveExecution();
  await eventually(() => session.status(accepted.jobId).state === "failed", "cancellation race did not fail closed");
  const status = session.status(accepted.jobId);
  assert.equal(status.completed, false);
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

test("a running disposable native job excludes canonical checkpoints after submit returns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-job-reservation-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const other = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const state = createDisposableState();
  const workflow = createDisposableWorkflow(state);
  const preview = await workflow.preview({ clipId: "clip-1", name: "Interview Clean" });
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { finish = resolve; });
  const delayedWorkflow = {
    getPreview: workflow.getPreview.bind(workflow),
    execute: async (...args: Parameters<typeof workflow.execute>) => { entered(); await held; return workflow.execute(...args); },
  };
  const session = createDisposableNativeOperationSession({ workflow: delayedWorkflow, native: state.native, recoveryGuard: guard });
  const accepted = await session.submit({ operation: "disposable.rename-clip", previewToken: preview.previewToken, projectId: preview.projectId, sequenceId: preview.sequenceId, targetIdentity: preview.targetIdentity, baseRevision: preview.baseRevision, idempotencyKey: "reservation-job" });
  try {
    await started;
    assert.equal(session.status(accepted.jobId).state, "executing");
    await assert.rejects(other.begin({ projectId: "project-1", sequenceId: "sequence-1", baseRevision: "revision-1", beforeDigest: "a".repeat(64), operation: "rename-clip" }), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    finish();
    await eventually(() => session.status(accepted.jobId).state === "completed", "job did not complete");
    await guard.assertClear();
  } finally {
    finish();
    await eventually(() => ["completed", "failed", "rolled_back"].includes(session.status(accepted.jobId).state), "job did not settle");
    await rm(directory, { recursive: true, force: true });
  }
});

test("disposable job reservations distinguish validation from uncertain mutation", async () => {
  for (const outcome of ["before-dispatch", "after-mutation"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "framekit-job-failure-"));
    const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
    const state = createDisposableState();
    state.native.trackNativeDispatch = async (operation) => operation();
    const workflow = createDisposableWorkflow(state);
    const preview = await workflow.preview({ clipId: "clip-1", name: "Interview Clean" });
    if (outcome === "after-mutation") state.native.edit = async () => { throw new Error("unknown native result"); };
    const failingWorkflow = {
      getPreview: workflow.getPreview.bind(workflow),
      execute: async (...args: Parameters<typeof workflow.execute>) => {
        if (outcome === "before-dispatch") throw new Error("validation failed");
        return workflow.execute(...args);
      },
    };
    const session = createDisposableNativeOperationSession({ workflow: failingWorkflow, native: state.native, recoveryGuard: guard });
    try {
      const job = await session.submit({ operation: "disposable.rename-clip", previewToken: preview.previewToken, projectId: preview.projectId, sequenceId: preview.sequenceId, targetIdentity: preview.targetIdentity, baseRevision: preview.baseRevision, idempotencyKey: outcome });
      await eventually(() => session.status(job.jobId).state === "failed", "job did not fail");
      if (outcome === "before-dispatch") await guard.assertClear();
      else assert.equal((await guard.inspectNativeReservation())?.operation, "native.job.disposable-rename");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("recovery evidence binds terminal receiver and canonical outcome for both routes", async () => {
  for (const kind of ["publish", "materialization"] as const) {
    const binding: RecoveryBinding = {
      kind, reservationId: "a".repeat(64), dispatchId: "dispatch-1", jobId: "job-1", executorIdentity: "receiver-1",
      target: kind === "publish" ? { libraryPath: "/tmp/target.fcpbundle", projectUid: "project-1", sequenceUid: "sequence-1" } : { libraryUid: "library", eventUid: "event", projectUid: "project", sequenceUid: "sequence" },
      expectedDigest: "b".repeat(64), outcome: "completed",
    };
    const receipt: ReceiverObservation = { reservationId: binding.reservationId, dispatchId: binding.dispatchId, jobId: binding.jobId,
      executorIdentity: binding.executorIdentity, state: "terminal", outcome: "completed", receiptId: "receipt-1" };
    const readback: CanonicalRecoveryObservation = { target: binding.target, digest: binding.expectedDigest,
      complete: true, sourceIntegrity: true, unrelatedProjectsUnchanged: true };
    let reads = 0;
    const verify = (receiver: ReceiverObservation, canonical: CanonicalRecoveryObservation) => verifyNativeRecovery(binding, {
      observeReceiver: async () => receiver,
      readCanonical: async () => { reads++; return canonical; },
    });
    assert.equal((await verify(receipt, readback)).receiptId, "receipt-1");
    for (const invalid of [
      { ...receipt, state: "running" as const }, { ...receipt, dispatchId: "other" },
      { ...receipt, executorIdentity: "other" }, { ...receipt, reservationId: "c".repeat(64) },
      { ...receipt, outcome: "failed" as const },
    ]) {
      const before = reads;
      await assert.rejects(verify(invalid, readback), /RECOVERY_EVIDENCE_INVALID/);
      assert.equal(reads, before, "canonical read must follow receiver quiescence");
    }
    for (const invalid of [
      { ...readback, target: { ...binding.target, unexpected: "other" } },
      { ...readback, digest: "d".repeat(64) }, { ...readback, complete: false },
      { ...readback, sourceIntegrity: false }, { ...readback, unrelatedProjectsUnchanged: false },
    ]) await assert.rejects(verify(receipt, invalid), /RECOVERY_EVIDENCE_INVALID/);
  }
});

test("recovery requires proven restoration and propagates unavailable receiver", async () => {
  const binding: RecoveryBinding = { kind: "publish", reservationId: "a".repeat(64), dispatchId: "dispatch-1", jobId: "job-1",
    executorIdentity: "receiver-1", target: { libraryPath: "/tmp/target.fcpbundle", projectUid: "project-1", sequenceUid: "sequence-1" }, expectedDigest: "b".repeat(64), outcome: "restored" };
  const receipt: ReceiverObservation = { reservationId: binding.reservationId, dispatchId: binding.dispatchId, jobId: binding.jobId,
    executorIdentity: binding.executorIdentity, state: "terminal", outcome: "failed", receiptId: "receipt-1" };
  const observation: CanonicalRecoveryObservation = { target: binding.target, digest: binding.expectedDigest,
    complete: true, sourceIntegrity: true, unrelatedProjectsUnchanged: true };
  const provider = { observeReceiver: async () => receipt, readCanonical: async () => observation };
  assert.equal((await verifyNativeRecovery(binding, provider)).outcome, "restored");
  assert.equal((await verifyNativeRecovery(binding, { ...provider, observeReceiver: async () => ({ ...receipt, outcome: "completed" as const }) })).outcome, "restored");
  await assert.rejects(verifyNativeRecovery(binding, { ...provider, readCanonical: async () => ({ ...observation, digest: "c".repeat(64) }) }), /RECOVERY_EVIDENCE_INVALID/);
  await assert.rejects(verifyNativeRecovery(binding, { ...provider, observeReceiver: async () => { throw new Error("receiver unavailable"); } }), /receiver unavailable/);
});

test("recovery rejects a receiver that changes during canonical readback", async () => {
  const binding: RecoveryBinding = { kind: "publish", reservationId: "a".repeat(64), dispatchId: "dispatch-1", jobId: "job-1",
    executorIdentity: "receiver-1", target: { libraryPath: "/tmp/target.fcpbundle", projectUid: "project-1", sequenceUid: "sequence-1" }, expectedDigest: "b".repeat(64), outcome: "completed" };
  const receipt: ReceiverObservation = { reservationId: binding.reservationId, dispatchId: binding.dispatchId, jobId: binding.jobId,
    executorIdentity: binding.executorIdentity, state: "terminal", outcome: "completed", receiptId: "receipt-original" };
  for (const changed of [
    { ...receipt, receiptId: "receipt-changed" },
    { ...receipt, state: "running" as const },
    { ...receipt, jobId: "other-job" },
  ]) {
    let reads = 0;
    await assert.rejects(verifyNativeRecovery(binding, {
      observeReceiver: async () => ++reads === 1 ? receipt : changed,
      readCanonical: async () => ({ target: binding.target, digest: binding.expectedDigest, complete: true, sourceIntegrity: true, unrelatedProjectsUnchanged: true }),
    }), /RECOVERY_EVIDENCE_INVALID/);
  }
});

test("an unresolved receiver never permits canonical readback", async () => {
  const binding: RecoveryBinding = { kind: "materialization", reservationId: "a".repeat(64), dispatchId: "dispatch-1", jobId: "job-1", executorIdentity: "receiver-1",
    target: { libraryUid: "library", eventUid: "event", projectUid: "project", sequenceUid: "sequence" }, expectedDigest: "b".repeat(64), outcome: "completed" };
  let rejectReceiver!: (reason: Error) => void;
  let read = false;
  const receiver = new Promise<ReceiverObservation>((_, reject) => { rejectReceiver = reject; });
  const pending = verifyNativeRecovery(binding, {
    observeReceiver: () => receiver,
    readCanonical: async () => { read = true; throw new Error("unexpected read"); },
  });
  await Promise.resolve();
  assert.equal(read, false);
  rejectReceiver(new Error("receiver timeout"));
  await assert.rejects(pending, /receiver timeout/);
  assert.equal(read, false);
});

test("recovery evidence can be queried after a mock receiver process exits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-recovery-receiver-"));
  const recordPath = join(directory, "receiver.json");
  const binding: RecoveryBinding = { kind: "materialization", reservationId: "a".repeat(64), dispatchId: "dispatch-1", jobId: "job-1", executorIdentity: "mock-receiver-1",
    target: { libraryUid: "library", eventUid: "event", projectUid: "project", sequenceUid: "sequence" }, expectedDigest: "b".repeat(64), outcome: "completed" };
  try {
    const receiver = spawnSync(process.execPath, ["-e", `
      const fs = require("node:fs");
      const b = JSON.parse(process.argv[2]);
      fs.writeFileSync(process.argv[1], JSON.stringify({reservationId: b.reservationId, dispatchId: b.dispatchId, jobId: b.jobId,
        executorIdentity: b.executorIdentity, state: "terminal", outcome: "completed", receiptId: "mock-receipt"}));
    `, recordPath, JSON.stringify(binding)], { encoding: "utf8" });
    assert.equal(receiver.status, 0, receiver.stderr);
    const result = await verifyNativeRecovery(binding, {
      observeReceiver: async () => JSON.parse(await readFile(recordPath, "utf8")) as ReceiverObservation,
      readCanonical: async () => ({ target: binding.target, digest: binding.expectedDigest, complete: true, sourceIntegrity: true, unrelatedProjectsUnchanged: true }),
    });
    assert.equal(result.receiptId, "mock-receipt");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("recovery binding is reconstructed from the same durable reservation", async () => {
  for (const kind of ["publish", "materialization"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "framekit-recovery-binding-"));
    const path = join(directory, "pending.json");
    const jobId = kind === "publish" ? "publish-job-123" : "materialization-123";
    const operation = `native.${kind === "publish" ? "publish" : "materialize"}.${createHash("sha256").update(jobId).digest("hex")}`;
    const target: Record<string, string> = kind === "publish" ? { libraryPath: "/tmp/target.fcpbundle", projectUid: "project-1", sequenceUid: "sequence-1" }
      : { libraryUid: "library", eventUid: "event", projectUid: "project-1", sequenceUid: "sequence-1" };
    const context = { kind, jobId, dispatchId: "00000000-0000-4000-8000-000000000001", executorIdentity: "mock-receiver-1",
      dispatchState: "intent", nativeQuiescence: "unproven", artifactDigest: "a".repeat(64), desiredDigest: "b".repeat(64),
      requestedTarget: kind === "publish" ? { libraryPath: "/tmp/target.fcpbundle" } : target,
      canonicalTarget: target, expectedCanonicalDigest: "b".repeat(64), expectedRestoreDigest: "c".repeat(64) };
    try {
      const owner = await new FileCanonicalRecoveryGuard(path).beginNative(operation, context as never);
      const restarted = new FileCanonicalRecoveryGuard(path);
      const reservation = await restarted.inspectNativeReservation();
      assert.ok(reservation);
      const binding = await recoveryBindingFromReservation(restarted, owner.reservationId, "completed");
      assert.deepEqual(binding, {
        kind, reservationId: owner.reservationId, jobId, dispatchId: context.dispatchId, executorIdentity: context.executorIdentity,
        target, expectedDigest: context.expectedCanonicalDigest, outcome: "completed",
      });
      const receipt: ReceiverObservation = { reservationId: owner.reservationId, jobId, dispatchId: context.dispatchId,
        executorIdentity: context.executorIdentity, state: "terminal", outcome: "completed", receiptId: "receiver-receipt" };
      const source = { observeReceiver: async () => receipt, readCanonical: async () => ({ target, digest: context.expectedCanonicalDigest,
        complete: true, sourceIntegrity: true, unrelatedProjectsUnchanged: true }) };
      assert.equal((await verifyNativeRecovery(binding, source)).receiptId, "receiver-receipt");
      await assert.rejects(verifyNativeRecovery(binding, { ...source, observeReceiver: async () => ({ ...receipt, dispatchId: "wrong" }) }), /RECOVERY_EVIDENCE_INVALID/);
      await assert.rejects(restarted.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
      assert.equal((await recoveryBindingFromReservation(restarted, owner.reservationId, "restored")).expectedDigest, context.expectedRestoreDigest);
      await assert.rejects(recoveryBindingFromReservation(restarted, "d".repeat(64), "completed"), /RECOVERY_EVIDENCE_INVALID/);
      await owner.release();
      for (const malformed of [
        { ...context, executorIdentity: "" },
        { ...context, dispatchState: "terminal" },
        { ...context, canonicalTarget: { ...target, projectUid: "" } },
        { ...context, canonicalTarget: kind === "publish" ? { ...target, libraryPath: "/tmp/other.fcpbundle" } : { ...target, libraryUid: "other" } },
        { ...context, expectedCanonicalDigest: "invalid" },
      ]) await assert.rejects(new FileCanonicalRecoveryGuard(path).beginNative(operation, malformed as never), /INVALID_OPERATION/);
      const oldContext = { ...context, executorIdentity: null };
      const v3 = await new FileCanonicalRecoveryGuard(path).beginNative(operation, oldContext as never);
      await assert.rejects(recoveryBindingFromReservation(restarted, v3.reservationId, "completed"), /RECOVERY_EVIDENCE_INVALID/);
      await v3.release();
      const noRestore = await new FileCanonicalRecoveryGuard(path).beginNative(operation, { ...context, expectedRestoreDigest: undefined } as never);
      await assert.rejects(recoveryBindingFromReservation(restarted, noRestore.reservationId, "restored"), /RECOVERY_EVIDENCE_INVALID/);
      await noRestore.release();
      const legacy = await new FileCanonicalRecoveryGuard(path).beginNative("native.searchmedia");
      await assert.rejects(recoveryBindingFromReservation(restarted, legacy.reservationId, "completed"), /RECOVERY_EVIDENCE_INVALID/);
      await legacy.release();
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("verified mock recovery releases only its reservation and is idempotent", async () => {
  for (const kind of ["publish", "materialization"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "framekit-verified-release-"));
    const path = join(directory, "pending.json");
    const jobId = kind === "publish" ? "publish-job-123" : "materialization-123";
    const operation = `native.${kind === "publish" ? "publish" : "materialize"}.${createHash("sha256").update(jobId).digest("hex")}`;
    const target: Record<string, string> = kind === "publish" ? { libraryPath: "/tmp/target.fcpbundle", projectUid: "project-1", sequenceUid: "sequence-1" }
      : { libraryUid: "library", eventUid: "event", projectUid: "project-1", sequenceUid: "sequence-1" };
    const context = { kind, jobId, dispatchId: "00000000-0000-4000-8000-000000000001", executorIdentity: "mock-receiver-1",
      dispatchState: "intent", nativeQuiescence: "unproven", artifactDigest: "a".repeat(64), desiredDigest: "b".repeat(64),
      requestedTarget: kind === "publish" ? { libraryPath: "/tmp/target.fcpbundle" } : target,
      canonicalTarget: target, expectedCanonicalDigest: "b".repeat(64) };
    try {
      const owner = await new FileCanonicalRecoveryGuard(path).beginNative(operation, context as never, { trackExecution: true });
      await owner.finishExecution!();
      const guard = new FileCanonicalRecoveryGuard(path);
      const receipt: ReceiverObservation = { reservationId: owner.reservationId, jobId, dispatchId: context.dispatchId,
        executorIdentity: context.executorIdentity, state: "terminal", outcome: "completed", receiptId: "mock-receipt" };
      const source = { observeReceiver: async () => receipt, readCanonical: async () => ({ target, digest: context.expectedCanonicalDigest,
        complete: true, sourceIntegrity: true, unrelatedProjectsUnchanged: true }) };
      await assert.rejects(recoverVerifiedNative(guard, owner.reservationId, "completed", { ...source, observeReceiver: async () => ({ ...receipt, state: "running" as const }) }), /RECOVERY_EVIDENCE_INVALID/);
      await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
      let receiverReads = 0;
      await assert.rejects(recoverVerifiedNative(guard, owner.reservationId, "completed", { ...source,
        observeReceiver: async () => ++receiverReads === 1 ? receipt : { ...receipt, state: "running" as const } }), /RECOVERY_EVIDENCE_INVALID/);
      assert.equal((await guard.inspectNativeReservation())?.reservationId, owner.reservationId);
      let enter!: () => void;
      let finish!: () => void;
      const started = new Promise<void>((resolve) => { enter = resolve; });
      const held = new Promise<void>((resolve) => { finish = resolve; });
      const recovery = recoverVerifiedNative(guard, owner.reservationId, "completed", { ...source,
        readCanonical: async () => { enter(); await held; return source.readCanonical(); } });
      await started;
      try {
        await assert.rejects(new FileCanonicalRecoveryGuard(path).beginNative("native.competing"), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
      } finally { finish(); }
      assert.deepEqual(await recovery, { outcome: "completed", alreadyReleased: false });
      await guard.assertClear();
      const receiptDirectory = `${path}.completed`;
      const movedReceipts = `${receiptDirectory}.moved`;
      await rename(receiptDirectory, movedReceipts);
      await symlink(movedReceipts, receiptDirectory);
      await assert.rejects(recoverVerifiedNative(new FileCanonicalRecoveryGuard(path), owner.reservationId, "completed", source), /RECOVERY_EVIDENCE_INVALID/);
      await rm(receiptDirectory);
      await rename(movedReceipts, receiptDirectory);
      const checkpointGuard = new FileCanonicalRecoveryGuard(path);
      await checkpointGuard.begin({ projectId: "new-project", sequenceId: "new-sequence", baseRevision: "new-revision", beforeDigest: "a".repeat(64), operation: "rename-clip" });
      assert.deepEqual(await recoverVerifiedNative(new FileCanonicalRecoveryGuard(path), owner.reservationId, "completed", source), { outcome: "completed", alreadyReleased: true });
      assert.equal((await checkpointGuard.inspect())?.projectId, "new-project");
      await checkpointGuard.complete();
      const replacement = await new FileCanonicalRecoveryGuard(path).beginNative("native.other");
      assert.deepEqual(await recoverVerifiedNative(new FileCanonicalRecoveryGuard(path), owner.reservationId, "completed", source), { outcome: "completed", alreadyReleased: true });
      assert.equal((await guard.inspectNativeReservation())?.reservationId, replacement.reservationId);
      await assert.rejects(recoverVerifiedNative(guard, replacement.reservationId, "completed", source), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED|RECOVERY_EVIDENCE_INVALID/);
      await replacement.release();
      const next = await new FileCanonicalRecoveryGuard(path).beginNative(operation, context as never, { trackExecution: true });
      await next.finishExecution!();
      const nextReceipt = { ...receipt, reservationId: next.reservationId };
      const interrupted = join(`${path}.completed`, next.reservationId);
      await writeFile(`${interrupted}.proof`, JSON.stringify({ reservationId: next.reservationId, outcome: "completed", receiptId: nextReceipt.receiptId }) + "\n");
      await link(path, interrupted);
      assert.equal(await guard.inspectCompletedNative(next.reservationId), false, "a receipt prepared before unlink is not a completed recovery");
      assert.deepEqual(await recoverVerifiedNative(guard, next.reservationId, "completed", { ...source, observeReceiver: async () => nextReceipt }), { outcome: "completed", alreadyReleased: false });
      assert.equal(await new FileCanonicalRecoveryGuard(path).inspectCompletedNative(next.reservationId), true);
      assert.equal(await guard.inspectCompletedNative("f".repeat(64)), false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("a separate sender process excludes recovery until its execution settles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-native-sender-process-"));
  const path = join(directory, "pending.json");
  const jobId = "publish-job-process";
  const operation = `native.publish.${createHash("sha256").update(jobId).digest("hex")}`;
  const context = { kind: "publish", jobId, dispatchId: "00000000-0000-4000-8000-000000000001", executorIdentity: "mock-receiver",
    dispatchState: "intent", nativeQuiescence: "unproven", artifactDigest: "a".repeat(64),
    requestedTarget: { libraryPath: "/tmp/target.fcpbundle" },
    canonicalTarget: { libraryPath: "/tmp/target.fcpbundle", projectUid: "project", sequenceUid: "sequence" }, expectedCanonicalDigest: "b".repeat(64) };
  const script = `
    import { FileCanonicalRecoveryGuard } from "@framekit/final-cut";
    const owner = await new FileCanonicalRecoveryGuard(process.argv[1]).beginNative(process.argv[2], JSON.parse(process.argv[3]), {trackExecution:true});
    process.stdout.write(owner.reservationId + "\\n");
    await new Promise((resolve) => process.stdin.once("data", resolve));
    await owner.finishExecution();
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, path, operation, JSON.stringify(context)], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exited = once(child, "exit");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [chunk] = await Promise.race([
      once(child.stdout, "data"),
      exited.then(() => { throw new Error(`sender exited before reservation: ${stderr}`); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("sender did not reserve")), 10_000); }),
    ]);
    clearTimeout(timer);
    const reservationId = String(chunk).trim();
    assert.match(reservationId, /^[a-f0-9]{64}$/);
    const other = new FileCanonicalRecoveryGuard(path);
    let reads = 0;
    const verify = async () => { reads++; return { receiptId: "mock-receipt", outcome: "completed" as const }; };
    await assert.rejects(other.completeVerifiedNative(reservationId, "completed", verify), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    assert.equal(reads, 0);
    child.stdin.end("finish\n");
    const [code] = await exited;
    assert.equal(code, 0, stderr);
    assert.deepEqual(await other.completeVerifiedNative(reservationId, "completed", verify), { outcome: "completed", alreadyReleased: false });
    assert.equal(reads, 1);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    await rm(directory, { recursive: true, force: true });
  }
});

test("sender crash leaves an uncertain reservation blocked after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-native-sender-crash-"));
  const path = join(directory, "pending.json");
  const jobId = "publish-job-crashed";
  const operation = `native.publish.${createHash("sha256").update(jobId).digest("hex")}`;
  const context = { kind: "publish", jobId, dispatchId: "00000000-0000-4000-8000-000000000001", executorIdentity: "mock-receiver",
    dispatchState: "intent", nativeQuiescence: "unproven", artifactDigest: "a".repeat(64),
    requestedTarget: { libraryPath: "/tmp/target.fcpbundle" },
    canonicalTarget: { libraryPath: "/tmp/target.fcpbundle", projectUid: "project", sequenceUid: "sequence" }, expectedCanonicalDigest: "b".repeat(64) };
  const script = `
    import { FileCanonicalRecoveryGuard } from "@framekit/final-cut";
    const owner = await new FileCanonicalRecoveryGuard(process.argv[1]).beginNative(process.argv[2], JSON.parse(process.argv[3]), {trackExecution:true});
    process.stdout.write(owner.reservationId + "\\n", () => process.kill(process.pid, "SIGKILL"));
  `;
  try {
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, path, operation, JSON.stringify(context)], { encoding: "utf8", timeout: 10_000 });
    assert.equal(child.signal, "SIGKILL", child.stderr);
    const reservationId = child.stdout.trim();
    assert.match(reservationId, /^[a-f0-9]{64}$/);
    const restarted = new FileCanonicalRecoveryGuard(path);
    let verified = false;
    await assert.rejects(restarted.completeVerifiedNative(reservationId, "completed", async () => {
      verified = true;
      return { receiptId: "mock-receipt", outcome: "completed" };
    }), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    assert.equal(verified, false);
    assert.equal((await restarted.inspectNativeReservation())?.reservationId, reservationId);
    await assert.rejects(restarted.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("untracked receiver reservation cannot claim sender settlement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-native-untracked-sender-"));
  const path = join(directory, "pending.json");
  const jobId = "publish-job-untracked";
  const operation = `native.publish.${createHash("sha256").update(jobId).digest("hex")}`;
  const context = { kind: "publish", jobId, dispatchId: "00000000-0000-4000-8000-000000000001", executorIdentity: "mock-receiver",
    dispatchState: "intent", nativeQuiescence: "unproven", artifactDigest: "a".repeat(64), requestedTarget: { libraryPath: "/tmp/target.fcpbundle" },
    canonicalTarget: { libraryPath: "/tmp/target.fcpbundle", projectUid: "project", sequenceUid: "sequence" }, expectedCanonicalDigest: "b".repeat(64) };
  try {
    const guard = new FileCanonicalRecoveryGuard(path);
    const reservation = await guard.beginNative(operation, context as never);
    let verified = false;
    await assert.rejects(guard.completeVerifiedNative(reservation.reservationId, "completed", async () => {
      verified = true;
      return { receiptId: "untrusted", outcome: "completed" };
    }), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    assert.equal(verified, false);
    assert.equal((await guard.inspectNativeReservation())?.reservationId, reservation.reservationId);
    const completed = `${path}.completed`;
    await mkdir(completed);
    await link(path, join(completed, reservation.reservationId));
    await writeFile(join(completed, `${reservation.reservationId}.proof`), JSON.stringify({ reservationId: reservation.reservationId, outcome: "completed", receiptId: "legacy" }));
    await rm(path);
    await assert.rejects(guard.inspectCompletedNative(reservation.reservationId), /RECOVERY_EVIDENCE_INVALID/);
    await assert.rejects(guard.completeVerifiedNative(reservation.reservationId, "completed", async () => ({ receiptId: "untrusted", outcome: "completed" })), /RECOVERY_EVIDENCE_INVALID/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a missing active marker does not prove sender settlement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-native-missing-activity-"));
  const path = join(directory, "pending.json");
  const jobId = "publish-job-marker";
  const operation = `native.publish.${createHash("sha256").update(jobId).digest("hex")}`;
  const context = { kind: "publish", jobId, dispatchId: "00000000-0000-4000-8000-000000000001", executorIdentity: "mock-receiver",
    dispatchState: "intent", nativeQuiescence: "unproven", artifactDigest: "a".repeat(64), requestedTarget: { libraryPath: "/tmp/target.fcpbundle" },
    canonicalTarget: { libraryPath: "/tmp/target.fcpbundle", projectUid: "project", sequenceUid: "sequence" }, expectedCanonicalDigest: "b".repeat(64) };
  try {
    const guard = new FileCanonicalRecoveryGuard(path);
    const reservation = await guard.beginNative(operation, context as never, { trackExecution: true });
    await reservation.finishExecution!();
    await guard.beginNativeExecution(reservation.reservationId);
    await rm(`${path}.active`);
    let verified = false;
    await assert.rejects(guard.completeVerifiedNative(reservation.reservationId, "completed", async () => {
      verified = true;
      return { receiptId: "untrusted", outcome: "completed" };
    }), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    assert.equal(verified, false);
    assert.equal((await guard.inspectNativeReservation())?.reservationId, reservation.reservationId);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
