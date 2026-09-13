import assert from "node:assert/strict";
import test from "node:test";
import {
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
