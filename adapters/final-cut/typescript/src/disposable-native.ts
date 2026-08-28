import { randomUUID } from "node:crypto";
import {
  canonicalSnapshotDigest,
  diffSnapshots,
  type ContextRevision,
  type ProjectSnapshot,
  type RuntimeCapabilities,
  type TimelineDiff,
  type VerificationCheck,
  type VerificationReport,
} from "@framekit/runtime";
import type {
  NativeFinalCutCapabilities,
  NativeFinalCutContext,
  NativeFinalCutEditor,
  NativeFinalCutEditResult,
  NativeFinalCutUndoResult,
} from "./native.js";

export interface NativeFinalCutDisposableRequest {
  /** Canonical timeline occurrence ID selected in Final Cut before preview. */
  clipId: string;
  /** New name used by the first disposable native operation. */
  name: string;
  baseRevision?: ContextRevision;
}

export interface NativeFinalCutDisposablePreview {
  previewToken: string;
  operation: {
    type: "rename-selected-clip";
    name: string;
  };
  target: {
    clipId: string;
    name: string;
  };
  baseRevision: ContextRevision;
  expiresAt: string;
}

export interface NativeFinalCutDisposableResult {
  operationId: string;
  previewToken: string;
  operation: NativeFinalCutDisposableRequest;
  native: NativeFinalCutEditResult;
  before: ProjectSnapshot;
  after: ProjectSnapshot;
  diff: TimelineDiff;
  beforeDigest: string;
  afterDigest: string;
  verification: VerificationReport;
  status: "VERIFIED" | "ROLLED_BACK";
  undoAvailable: boolean;
  restored?: ProjectSnapshot;
  restoredDigest?: string;
}

export interface NativeFinalCutDisposableUndoResult {
  operationId: string;
  undone: boolean;
  native: NativeFinalCutUndoResult;
  restored: ProjectSnapshot;
  beforeDigest: string;
  restoredDigest: string;
  verification: VerificationReport;
}

export interface DisposableNativeEditWorkflowOptions {
  native: Pick<NativeFinalCutEditor, "capabilities" | "inspect" | "edit" | "undo">;
  readCanonicalSnapshot: () => Promise<ProjectSnapshot>;
  readCanonicalCapabilities: () => Promise<RuntimeCapabilities>;
  now?: () => number;
  previewTtlMs?: number;
}

interface PreviewRecord {
  request: NativeFinalCutDisposableRequest;
  before: ProjectSnapshot;
  nativeTarget: NativeFinalCutContext["target"];
  expiresAt: number;
}

interface ExecutedRecord {
  request: NativeFinalCutDisposableRequest;
  before: ProjectSnapshot;
  after: ProjectSnapshot;
  beforeDigest: string;
  operationId: string;
}

/**
 * Composes one guarded native UI edit with a canonical snapshot provider.
 * Native UI is the mutation surface; canonical snapshots are the proof surface.
 */
export class DisposableNativeEditWorkflow {
  private readonly previews = new Map<string, PreviewRecord>();
  private readonly operations = new Map<string, ExecutedRecord>();
  private readonly now: () => number;
  private readonly previewTtlMs: number;

  public constructor(private readonly options: DisposableNativeEditWorkflowOptions) {
    this.now = options.now ?? Date.now;
    this.previewTtlMs = options.previewTtlMs ?? 30_000;
  }

  public async preview(request: NativeFinalCutDisposableRequest): Promise<NativeFinalCutDisposablePreview> {
    validateRequest(request);
    const before = await this.readCanonical("preview");
    if (request.baseRevision && !sameRevision(request.baseRevision, before.revision)) {
      throw new Error("STALE_CONTEXT: disposable native preview base revision does not match current canonical state");
    }
    const target = before.timeline.clips.find((clip) => clip.id === request.clipId);
    if (!target) throw new Error(`TARGET_MISMATCH: canonical target occurrence was not found: ${request.clipId}`);
    if (target.name === request.name) {
      throw new Error("INVALID_OPERATION: disposable native rename must change the target name");
    }
    const nativeTarget = await this.assertNativeTarget(before, target.name);
    const previewToken = `disposable-native-preview-${randomToken()}`;
    const expiresAt = this.now() + this.previewTtlMs;
    this.prunePreviews();
    this.previews.set(previewToken, { request: structuredClone(request), before, nativeTarget, expiresAt });
    return {
      previewToken,
      operation: { type: "rename-selected-clip", name: request.name },
      target: { clipId: target.id, name: target.name },
      baseRevision: structuredClone(before.revision),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  public async execute(previewToken: string): Promise<NativeFinalCutDisposableResult> {
    const preview = this.previews.get(previewToken);
    if (!preview) throw new Error(`PREVIEW_TOKEN_INVALID: unknown or already used preview ${previewToken}`);
    this.previews.delete(previewToken);
    if (this.now() > preview.expiresAt) throw new Error("PREVIEW_TOKEN_EXPIRED: disposable native preview has expired");

    const current = await this.readCanonical("execute");
    if (!sameRevision(preview.before.revision, current.revision)) {
      throw new Error("STALE_CONTEXT: disposable native preview base revision does not match current canonical state");
    }
    const currentTarget = current.timeline.clips.find((clip) => clip.id === preview.request.clipId);
    if (!currentTarget || currentTarget.name !== preview.before.timeline.clips.find((clip) => clip.id === preview.request.clipId)?.name) {
      throw new Error("TARGET_MISMATCH: canonical target changed after disposable native preview");
    }
    await this.assertNativeTarget(current, currentTarget.name, preview.nativeTarget);

    const native = await this.options.native.edit({ type: "rename-selected-clip", name: preview.request.name });
    let after: ProjectSnapshot;
    try {
      after = await this.readCanonical("read-after-write");
    } catch (error) {
      await this.compensate(native.operationId, preview.before, preview.request.clipId, error, "READ_AFTER_WRITE_FAILED");
      throw new Error(`READ_AFTER_WRITE_FAILED: canonical state was restored (${String(error)})`);
    }

    const diff = diffSnapshots(preview.before, after);
    const beforeDigest = canonicalSnapshotDigest(preview.before);
    const afterDigest = canonicalSnapshotDigest(after);
    const verification = verifyDisposableRename(preview.before, after, diff, preview.request);
    if (!verification.passed) {
      const restored = await this.compensate(native.operationId, preview.before, preview.request.clipId, verification, "VERIFICATION_FAILED");
      return {
        operationId: native.operationId,
        previewToken,
        operation: structuredClone(preview.request),
        native,
        before: preview.before,
        after,
        diff,
        beforeDigest,
        afterDigest,
        verification,
        status: "ROLLED_BACK",
        undoAvailable: false,
        restored,
        restoredDigest: canonicalSnapshotDigest(restored),
      };
    }

    this.operations.set(native.operationId, {
      request: structuredClone(preview.request),
      before: preview.before,
      after,
      beforeDigest,
      operationId: native.operationId,
    });
    return {
      operationId: native.operationId,
      previewToken,
      operation: structuredClone(preview.request),
      native,
      before: preview.before,
      after,
      diff,
      beforeDigest,
      afterDigest,
      verification,
      status: "VERIFIED",
      undoAvailable: native.undoAvailable,
    };
  }

  public async undo(operationId: string): Promise<NativeFinalCutDisposableUndoResult> {
    const operation = this.operations.get(operationId);
    if (!operation) throw new Error(`NATIVE_DISPOSABLE_UNDO_UNAVAILABLE: unknown operation ${operationId}`);
    const current = await this.readCanonical("undo");
    if (!sameRevision(current.revision, operation.after.revision)) {
      throw new Error("STALE_CONTEXT: disposable native operation changed after execute");
    }
    if (current.projectId !== operation.before.projectId || current.timeline.id !== operation.before.timeline.id) {
      throw new Error("TARGET_MISMATCH: disposable native operation target changed before undo");
    }
    const native = await this.options.native.undo(operationId);
    if (!native.undone) throw new Error("ROLLBACK_FAILED: native Undo did not report restoration");
    let restored: ProjectSnapshot;
    try {
      restored = await this.readCanonical("undo read-after-write");
    } catch (error) {
      throw new Error(`READ_AFTER_UNDO_FAILED: native Undo completed but canonical restoration could not be observed (${String(error)})`);
    }
    const restoredDigest = canonicalSnapshotDigest(restored);
    const verification = verifyRestoration(operation.before, restored, operation.beforeDigest, operation.request.clipId);
    if (!verification.passed) {
      throw new Error(`ROLLBACK_FAILED: ${verification.checks.find((check) => !check.passed)?.detail ?? "canonical digest mismatch"}`);
    }
    this.operations.delete(operationId);
    return {
      operationId,
      undone: true,
      native,
      restored,
      beforeDigest: operation.beforeDigest,
      restoredDigest,
      verification,
    };
  }

  private async readCanonical(stage: string): Promise<ProjectSnapshot> {
    const capabilities = await this.options.readCanonicalCapabilities().catch((error) => {
      throw new Error(`CAPABILITY_UNAVAILABLE: disposable native canonical snapshot (${String(error)})`);
    });
    const editor = capabilities.editor;
    if (
      editor.canonicalTimelineMode === "metadata-only"
      || !editor.projectRead
      || !editor.timelineSnapshotRead
      || !editor.projectCatalogRead
      || !editor.projectSelection
    ) {
      throw new Error(`CAPABILITY_UNAVAILABLE: disposable native canonical snapshot is unavailable during ${stage}`);
    }
    try {
      return await this.options.readCanonicalSnapshot();
    } catch (error) {
      throw new Error(`CAPABILITY_UNAVAILABLE: disposable native canonical snapshot (${String(error)})`);
    }
  }

  private async assertNativeTarget(
    snapshot: ProjectSnapshot,
    expectedName: string,
    previousTarget?: NativeFinalCutContext["target"],
  ): Promise<NativeFinalCutContext["target"]> {
    const capabilities = this.options.native.capabilities();
    assertNativeCapabilities(capabilities);
    const context = await this.options.native.inspect();
    if (!context.available || !context.frontmost || !context.timelineWindowAvailable || !context.timelineFocused) {
      throw new Error("CAPABILITY_UNAVAILABLE: disposable native timeline preflight");
    }
    if (context.project && context.project !== snapshot.projectName) {
      throw new Error("TARGET_MISMATCH: native project does not match canonical project");
    }
    if (context.sequence && context.sequence !== snapshot.timeline.name) {
      throw new Error("TARGET_MISMATCH: native sequence does not match canonical timeline");
    }
    if (context.target.kind !== "selected-clip" || context.target.name !== expectedName) {
      throw new Error("TARGET_MISMATCH: native selected clip does not match the canonical target");
    }
    if (previousTarget?.identity && context.target.identity && previousTarget.identity !== context.target.identity) {
      throw new Error("TARGET_MISMATCH: native selected clip identity changed after disposable preview");
    }
    return context.target;
  }

  private async compensate(
    operationId: string,
    before: ProjectSnapshot,
    clipId: string,
    cause: unknown,
    code: string,
  ): Promise<ProjectSnapshot> {
    try {
      const native = await this.options.native.undo(operationId);
      if (!native.undone) throw new Error("native Undo did not report restoration");
      const restored = await this.readCanonical("compensating undo");
      const verification = verifyRestoration(before, restored, canonicalSnapshotDigest(before), clipId);
      if (!verification.passed) throw new Error(verification.checks.find((check) => !check.passed)?.detail ?? "canonical digest mismatch");
      return restored;
    } catch (rollbackError) {
      throw new Error(`${code}: compensating native Undo failed (${String(cause)}; ${String(rollbackError)})`);
    }
  }

  private prunePreviews(): void {
    const now = this.now();
    for (const [token, preview] of this.previews) {
      if (now > preview.expiresAt) this.previews.delete(token);
    }
  }
}

function validateRequest(request: NativeFinalCutDisposableRequest): void {
  if (!request.clipId.trim()) throw new Error("INVALID_OPERATION: disposable native clipId is required");
  if (!request.name.trim()) throw new Error("INVALID_OPERATION: disposable native name is required");
}

function assertNativeCapabilities(capabilities: NativeFinalCutCapabilities): void {
  if (!capabilities.selectionEdit || !capabilities.undo) {
    throw new Error("CAPABILITY_UNAVAILABLE: disposable native edit requires selection edit and Undo");
  }
}

function verifyDisposableRename(
  before: ProjectSnapshot,
  after: ProjectSnapshot,
  diff: TimelineDiff,
  request: NativeFinalCutDisposableRequest,
): VerificationReport {
  const beforeTarget = before.timeline.clips.find((clip) => clip.id === request.clipId);
  const afterTarget = after.timeline.clips.find((clip) => clip.id === request.clipId);
  const modifiedIds = diff.modified.map((change) => change.itemId);
  const checks: VerificationCheck[] = [
    {
      name: "canonical-revision-advanced",
      passed: after.revision.sequence > before.revision.sequence,
      detail: `canonical revision ${before.revision.sequence} -> ${after.revision.sequence}`,
    },
    {
      name: "target-renamed",
      passed: Boolean(beforeTarget && afterTarget && beforeTarget.name !== afterTarget.name && afterTarget.name === request.name),
      detail: afterTarget ? `observed target name ${afterTarget.name}` : "target occurrence is missing after native edit",
    },
    {
      name: "deterministic-target-diff",
      passed: diff.added.length === 0 && diff.removed.length === 0 && modifiedIds.length === 1 && modifiedIds[0] === request.clipId,
      detail: `diff added=${diff.added.length}, removed=${diff.removed.length}, modified=${modifiedIds.join(",") || "none"}`,
    },
  ];
  return { passed: checks.every((check) => check.passed), checks };
}

function verifyRestoration(
  before: ProjectSnapshot,
  restored: ProjectSnapshot,
  beforeDigest: string,
  clipId: string,
): VerificationReport {
  const restoredDigest = canonicalSnapshotDigest(restored);
  const checks: VerificationCheck[] = [
    {
      name: "canonical-digest-restored",
      passed: restoredDigest === beforeDigest,
      detail: `expected digest ${beforeDigest}, observed ${restoredDigest}`,
    },
    {
      name: "canonical-target-restored",
      passed: restored.timeline.clips.some((clip) => clip.id === clipId),
      detail: `canonical target occurrence ${clipId} is present after native Undo`,
    },
  ];
  return { passed: checks.every((check) => check.passed), checks };
}

function sameRevision(left: ContextRevision, right: ContextRevision): boolean {
  return left.id === right.id && left.sequence === right.sequence;
}

function randomToken(): string {
  return randomUUID();
}
