import { randomUUID } from "node:crypto";
import type { ContextRevision } from "@framekit/runtime";
import type {
  DisposableNativeEditWorkflow,
  NativeFinalCutDisposableResult,
} from "./disposable-native.js";
import type { NativeFinalCutEditor } from "./native.js";
import type { NativeFinalCutReadiness } from "./native.js";

export type NativeOperationSessionState =
  | "planned"
  | "waiting_for_final_cut"
  | "executing"
  | "verifying"
  | "completed"
  | "rolled_back"
  | "failed"
  | "cancelled";

export interface NativeOperationSessionRequest {
  operation: string;
  previewToken: string;
  projectId: string;
  sequenceId: string;
  targetIdentity: string;
  baseRevision: ContextRevision;
  idempotencyKey: string;
}

export interface NativeOperationReadinessResult {
  readiness: NativeFinalCutReadiness;
  error?: {
    code: string;
    message: string;
  };
}

export interface NativeOperationSessionEvidence {
  readback: {
    status: "verified" | "unverified";
    revision?: ContextRevision;
    detail: string;
  };
  diff: {
    added: number;
    removed: number;
    modified: number;
  };
  verification: {
    status: "verified" | "failed";
    checks: Array<{
      name: string;
      passed: boolean;
      detail: string;
    }>;
  };
  rollback: {
    status: "available" | "restored" | "not-required" | "failed" | "unknown";
    operationId?: string;
    detail: string;
  };
}

export interface NativeOperationSessionExecution {
  outcome: "completed" | "rolled_back";
  evidence: NativeOperationSessionEvidence;
}

export interface NativeOperationExecutionContext {
  signal: AbortSignal;
  markMutationStarted(): void;
}

export interface NativeOperationSessionExecutor {
  checkReadiness(
    request: NativeOperationSessionRequest,
    options: Pick<NativeOperationExecutionContext, "signal">,
  ): Promise<NativeOperationReadinessResult>;
  revalidate(
    request: NativeOperationSessionRequest,
    options: Pick<NativeOperationExecutionContext, "signal">,
  ): Promise<void>;
  execute(
    request: NativeOperationSessionRequest,
    context: NativeOperationExecutionContext,
  ): Promise<NativeOperationSessionExecution>;
}

export interface NativeOperationSessionError {
  code: string;
  message: string;
  retryable: boolean;
  recovery?: "required";
}

export interface NativeOperationSessionJob {
  jobId: string;
  operation: string;
  previewToken: string;
  projectId: string;
  sequenceId: string;
  targetIdentity: string;
  baseRevision: ContextRevision;
  idempotencyKey: string;
  state: NativeOperationSessionState;
  accepted: boolean;
  completed: boolean;
  verified: boolean;
  restored: boolean;
  cancelRequested: boolean;
  submittedAt: string;
  updatedAt: string;
  expiresAt: string;
  readiness?: NativeOperationReadinessResult["readiness"];
  evidence?: NativeOperationSessionEvidence;
  error?: NativeOperationSessionError;
}

export interface NativeOperationSessionOptions {
  executor: NativeOperationSessionExecutor;
  now?: () => number;
  jobTtlMs?: number;
}

interface JobRecord {
  jobId: string;
  request: NativeOperationSessionRequest;
  state: NativeOperationSessionState;
  submittedAt: string;
  updatedAt: string;
  expiresAt: string;
  readiness?: NativeOperationReadinessResult["readiness"];
  evidence?: NativeOperationSessionEvidence;
  error?: NativeOperationSessionError;
  cancelRequested: boolean;
  mutationStarted: boolean;
  controller: AbortController;
}

/**
 * Coordinates previewed native work without turning unavailable Final Cut UI
 * into a blocking MCP request. Job records intentionally remain process-local.
 */
export class NativeOperationSession {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly idempotency = new Map<string, JobRecord>();
  private readonly now: () => number;
  private readonly jobTtlMs: number;

  public constructor(private readonly options: NativeOperationSessionOptions) {
    this.now = options.now ?? Date.now;
    this.jobTtlMs = options.jobTtlMs ?? 60_000;
    if (!Number.isInteger(this.jobTtlMs) || this.jobTtlMs < 1) {
      throw new Error("INVALID_OPERATION: native operation session jobTtlMs must be a positive integer");
    }
  }

  public async submit(request: NativeOperationSessionRequest): Promise<NativeOperationSessionJob> {
    validateRequest(request);
    const existing = this.idempotency.get(request.idempotencyKey);
    if (existing) {
      if (!sameRequest(existing.request, request)) {
        throw new Error("NATIVE_OPERATION_IDEMPOTENCY_CONFLICT: idempotency key is bound to a different native request");
      }
      return this.snapshot(existing);
    }

    const submittedAt = new Date(this.now()).toISOString();
    const job: JobRecord = {
      jobId: `native-job-${randomUUID()}`,
      request: structuredClone(request),
      state: "planned",
      submittedAt,
      updatedAt: submittedAt,
      expiresAt: new Date(this.now() + this.jobTtlMs).toISOString(),
      cancelRequested: false,
      mutationStarted: false,
      controller: new AbortController(),
    };
    this.jobs.set(job.jobId, job);
    this.idempotency.set(request.idempotencyKey, job);
    void this.process(job);
    return this.snapshot(job);
  }

  public status(jobId: string): NativeOperationSessionJob {
    return this.snapshot(this.requireJob(jobId));
  }

  public async retry(jobId: string): Promise<NativeOperationSessionJob> {
    const job = this.requireJob(jobId);
    if (job.state !== "waiting_for_final_cut") {
      throw new Error(`NATIVE_OPERATION_SESSION_NOT_RETRYABLE: job ${jobId} is ${job.state}`);
    }
    if (this.isExpired(job)) {
      this.expire(job);
      return this.snapshot(job);
    }
    if (!job.readiness?.retryable || !["retry", "queue"].includes(job.readiness.nextAction)) {
      throw new Error(`NATIVE_OPERATION_SESSION_NOT_RETRYABLE: job ${jobId} has no retryable Final Cut readiness state`);
    }
    job.cancelRequested = false;
    job.mutationStarted = false;
    job.controller = new AbortController();
    this.setState(job, "planned");
    void this.process(job);
    return this.snapshot(job);
  }

  public async cancel(jobId: string): Promise<NativeOperationSessionJob> {
    const job = this.requireJob(jobId);
    if (isTerminal(job.state)) return this.snapshot(job);
    if (job.state === "planned" || job.state === "waiting_for_final_cut") {
      job.cancelRequested = true;
      job.controller.abort();
      this.setState(job, "cancelled");
      return this.snapshot(job);
    }
    job.cancelRequested = true;
    job.controller.abort();
    return this.snapshot(job);
  }

  private async process(job: JobRecord): Promise<void> {
    if (job.cancelRequested || isTerminal(job.state)) return;
    if (this.isExpired(job)) {
      this.expire(job);
      return;
    }

    try {
      const readiness = await this.options.executor.checkReadiness(job.request, { signal: job.controller.signal });
      if (job.cancelRequested) return;
      job.readiness = structuredClone(readiness.readiness);
      if (readiness.readiness.state !== "ready") {
        job.error = readiness.error
          ? { ...readiness.error, retryable: readiness.readiness.retryable }
          : {
              code: "NATIVE_OPERATION_SESSION_WAITING",
              message: readiness.readiness.guidance,
              retryable: readiness.readiness.retryable,
            };
        this.setState(job, "waiting_for_final_cut");
        return;
      }

      this.setState(job, "executing");
      const context: NativeOperationExecutionContext = {
        signal: job.controller.signal,
        markMutationStarted: () => {
          job.mutationStarted = true;
        },
      };
      await this.options.executor.revalidate(job.request, context);
      if (job.cancelRequested) throw new Error("FINAL_CUT_NATIVE_CANCELLED: native request was cancelled");
      const execution = await this.options.executor.execute(job.request, context);
      this.setState(job, "verifying");
      job.evidence = structuredClone(execution.evidence);
      this.setState(job, execution.outcome);
    } catch (error) {
      this.handleFailure(job, error);
    }
  }

  private handleFailure(job: JobRecord, error: unknown): void {
    const failure = sessionError(error);
    if (job.cancelRequested || failure.code === "FINAL_CUT_NATIVE_CANCELLED") {
      if (job.mutationStarted) {
        job.error = {
          code: "NATIVE_OPERATION_CANCELLATION_REQUIRES_RECOVERY",
          message: "Native mutation started before cancellation; inspect and restore the operation before retrying",
          retryable: false,
          recovery: "required",
        };
        this.setState(job, "failed");
      } else {
        job.error = failure;
        this.setState(job, "cancelled");
      }
      return;
    }
    if (!job.mutationStarted && failure.retryable) {
      job.error = failure;
      this.setState(job, "waiting_for_final_cut");
      return;
    }
    job.error = failure;
    this.setState(job, "failed");
  }

  private expire(job: JobRecord): void {
    job.error = {
      code: "NATIVE_OPERATION_SESSION_EXPIRED",
      message: "Native operation session expired before execution",
      retryable: false,
    };
    this.setState(job, "failed");
  }

  private isExpired(job: JobRecord): boolean {
    return this.now() >= Date.parse(job.expiresAt);
  }

  private setState(job: JobRecord, state: NativeOperationSessionState): void {
    job.state = state;
    job.updatedAt = new Date(this.now()).toISOString();
  }

  private requireJob(jobId: string): JobRecord {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`NATIVE_OPERATION_SESSION_NOT_FOUND: unknown job ${jobId}`);
    return job;
  }

  private snapshot(job: JobRecord): NativeOperationSessionJob {
    return structuredClone({
      jobId: job.jobId,
      operation: job.request.operation,
      previewToken: job.request.previewToken,
      projectId: job.request.projectId,
      sequenceId: job.request.sequenceId,
      targetIdentity: job.request.targetIdentity,
      baseRevision: job.request.baseRevision,
      idempotencyKey: job.request.idempotencyKey,
      state: job.state,
      accepted: true,
      completed: job.state === "completed",
      verified: job.evidence?.verification.status === "verified",
      restored: job.evidence?.rollback.status === "restored",
      cancelRequested: job.cancelRequested,
      submittedAt: job.submittedAt,
      updatedAt: job.updatedAt,
      expiresAt: job.expiresAt,
      ...(job.readiness ? { readiness: job.readiness } : {}),
      ...(job.evidence ? { evidence: job.evidence } : {}),
      ...(job.error ? { error: job.error } : {}),
    });
  }
}

export interface DisposableNativeOperationSessionOptions {
  workflow: Pick<DisposableNativeEditWorkflow, "execute" | "getPreview">;
  native: Pick<NativeFinalCutEditor, "inspect">;
  now?: () => number;
  jobTtlMs?: number;
}

/** Adapts the existing canonical disposable rename workflow to session jobs. */
export function createDisposableNativeOperationSession(
  options: DisposableNativeOperationSessionOptions,
): NativeOperationSession {
  return new NativeOperationSession({
    now: options.now,
    jobTtlMs: options.jobTtlMs,
    executor: {
      checkReadiness: async (_request, { signal }) => {
        const context = await options.native.inspect({ signal });
        return {
          readiness: context.readiness,
          ...(context.error ? { error: { code: context.error.code, message: context.error.message } } : {}),
        };
      },
      revalidate: async (request) => {
        if (request.operation !== "disposable.rename-clip") {
          throw new Error(`NATIVE_OPERATION_SESSION_UNSUPPORTED: unsupported operation ${request.operation}`);
        }
        const preview = options.workflow.getPreview(request.previewToken);
        if (!preview) throw new Error("PREVIEW_TOKEN_STALE: disposable native preview is missing or expired");
        if (preview.projectId !== request.projectId || preview.sequenceId !== request.sequenceId || preview.targetIdentity !== request.targetIdentity) {
          throw new Error("TARGET_MISMATCH: native session binding does not match the disposable preview");
        }
        if (!sameRevision(preview.baseRevision, request.baseRevision)) {
          throw new Error("STALE_CONTEXT: native session base revision does not match the disposable preview");
        }
      },
      execute: async (request, context) => {
        const result = await options.workflow.execute(request.previewToken, {
          signal: context.signal,
          onMutationStart: context.markMutationStarted,
        });
        return {
          outcome: result.status === "VERIFIED" ? "completed" : "rolled_back",
          evidence: disposableEvidence(result),
        };
      },
    },
  });
}

function validateRequest(request: NativeOperationSessionRequest): void {
  for (const [name, value] of Object.entries({
    operation: request.operation,
    previewToken: request.previewToken,
    projectId: request.projectId,
    sequenceId: request.sequenceId,
    targetIdentity: request.targetIdentity,
    idempotencyKey: request.idempotencyKey,
  })) {
    if (!value.trim()) throw new Error(`INVALID_OPERATION: native operation session ${name} is required`);
  }
  if (!request.baseRevision.id.trim() || !Number.isInteger(request.baseRevision.sequence)) {
    throw new Error("INVALID_OPERATION: native operation session baseRevision is invalid");
  }
}

function sameRequest(left: NativeOperationSessionRequest, right: NativeOperationSessionRequest): boolean {
  return left.operation === right.operation
    && left.previewToken === right.previewToken
    && left.projectId === right.projectId
    && left.sequenceId === right.sequenceId
    && left.targetIdentity === right.targetIdentity
    && left.baseRevision.id === right.baseRevision.id
    && left.baseRevision.sequence === right.baseRevision.sequence;
}

function sameRevision(left: ContextRevision, right: ContextRevision): boolean {
  return left.id === right.id && left.sequence === right.sequence;
}

function disposableEvidence(result: NativeFinalCutDisposableResult): NativeOperationSessionEvidence {
  const rollbackStatus = result.status === "ROLLED_BACK"
    ? result.restoredDigest === result.beforeDigest ? "restored" : "failed"
    : result.undoAvailable ? "available" : "not-required";
  return {
    readback: {
      status: result.status === "VERIFIED" ? "verified" : "unverified",
      revision: structuredClone(result.after.revision),
      detail: result.status === "VERIFIED"
        ? "Canonical read-after-write observed the requested target"
        : "Canonical read-after-write did not verify the requested target",
    },
    diff: {
      added: result.diff.added.length,
      removed: result.diff.removed.length,
      modified: result.diff.modified.length,
    },
    verification: {
      status: result.verification.passed ? "verified" : "failed",
      checks: result.verification.checks.map((check) => ({
        name: check.name,
        passed: check.passed,
        detail: check.detail,
      })),
    },
    rollback: {
      status: rollbackStatus,
      operationId: result.operationId,
      detail: rollbackStatus === "available"
        ? "Final Cut Undo is available for this operation"
        : rollbackStatus === "restored"
          ? "Canonical readback verified native Undo restoration"
          : rollbackStatus === "failed"
            ? "Native rollback did not restore the original canonical digest"
            : "No native Undo is required for this result",
    },
  };
}

function isTerminal(state: NativeOperationSessionState): boolean {
  return state === "completed" || state === "rolled_back" || state === "failed" || state === "cancelled";
}

function sessionError(error: unknown): NativeOperationSessionError {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : message.split(":", 1)[0] || "NATIVE_OPERATION_SESSION_FAILED";
  return {
    code,
    message,
    retryable: isRetryable(code),
  };
}

function isRetryable(code: string): boolean {
  return code === "FINAL_CUT_NATIVE_NOT_FRONTMOST"
    || code === "FINAL_CUT_NATIVE_NO_TIMELINE_WINDOW"
    || code === "FINAL_CUT_NATIVE_TIMELINE_FOCUS_REQUIRED"
    || code === "FINAL_CUT_NATIVE_OVERLAY_BLOCKED"
    || code === "FINAL_CUT_NATIVE_APPLE_EVENT_TIMEOUT"
    || code === "FINAL_CUT_NATIVE_AUTOMATION_FAILED";
}
