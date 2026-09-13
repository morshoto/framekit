# ADR-0010: Resumable Native Operation Sessions

- Status: Accepted
- Date: 2026-09-13
- Issue: [#259](https://github.com/morshoto/framekit/issues/259)

## Context

Headed Final Cut operations require a frontmost application, a focused
timeline, and native readback. Waiting synchronously for those conditions
turns an otherwise useful preview into a blocked MCP request. The existing
native adapter already reports bounded readiness and the disposable native
workflow already produces canonical diff, verification, and Undo evidence.

## Decision

Add a process-local `NativeOperationSession` around previewed native work. The
first adapter is the disposable native rename workflow; the session contract is
generic so the remaining preview/execute operations can adopt it incrementally.
The session exposes these MCP tools:

- `editor.native.operation.submit`
- `editor.native.operation.status`
- `editor.native.operation.retry`
- `editor.native.operation.cancel`

A submission is bound to all of the following values:

```json
{
  "operation": "disposable.rename-clip",
  "previewToken": "...",
  "projectId": "...",
  "sequenceId": "...",
  "targetIdentity": "...",
  "baseRevision": { "id": "...", "sequence": 1, "timestamp": "..." },
  "idempotencyKey": "..."
}
```

The lifecycle is:

```text
planned -> waiting_for_final_cut -> executing -> verifying
                                      |             |
                                      +--> failed  +--> completed
                                                    +--> rolled_back
```

Cancellation is an explicit terminal `cancelled` state. It cancels a job that
has not started mutation. If cancellation races with a mutation, the session
returns a recovery-required failure instead of claiming that the operation was
cancelled safely.

`submit` returns the accepted job without waiting for native readiness or
completion. Callers poll `status`; `retry` explicitly resumes a retryable
`waiting_for_final_cut` job. No tool activates or focuses Final Cut implicitly,
and no completion notification is claimed by this first implementation.

Terminal and expired jobs remain available in memory for five minutes after
their `expiresAt` so callers can read the terminal status and safely repeat an
idempotent submission. After that retention window, the job and its
idempotency entry are pruned together; status returns not-found and reusing the
key creates a new job.

Before execution, the session compares the submitted binding with the stored
preview. The wrapped workflow then rechecks the canonical revision and native
target immediately before mutation. Any mismatch fails closed and the native
executor is not called.

Terminal status exposes separate `accepted`, `completed`, `verified`, and
`restored` facts. It includes sanitized readiness/error diagnostics and, after
execution, readback revision, diff counts, verification checks, and native
Undo/rollback state. Raw operation results are not returned from session status
so private media paths and credentials cannot leak through job diagnostics.

## Consequences

- A missing frontmost Final Cut session becomes a pollable, actionable job
  rather than a blocking request.
- Native work remains headed-only and fail-closed; the session does not turn a
  queued UI operation into background-native execution.
- Jobs and idempotency keys are lost when the MCP process exits. Durable
  persistence and restart recovery require a separate design.
- The existing operation-specific preview/execute tools remain available. The
  session path is additive and initially covers only disposable native rename.

## TDD plan

1. Prove lifecycle transitions, readiness waiting, cancellation, idempotency,
   expiry, stale binding rejection, and safe evidence with deterministic tests.
2. Implement the smallest in-memory session state machine and keep execution
   behind injected readiness, revalidation, execution, and evidence seams.
3. Wrap `DisposableNativeEditWorkflow`, propagate cancellation to native
   inspection/edit calls, and map canonical diff/readback/Undo evidence.
4. Expose submit/status/retry/cancel MCP tools and test their schemas and
   polling behavior.
5. Run the repository build, tests, boundary checks, and native project check.
