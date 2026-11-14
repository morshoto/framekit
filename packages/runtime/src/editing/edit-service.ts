import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolve as resolvePath } from "node:path";
import { diffSnapshots } from "../timeline/snapshot-diff.js";
import { canonicalSnapshotDigest } from "../timeline/snapshot-digest.js";
import type { EditorPort } from "../domain/ports.js";
import type {
  ArtifactEditTarget,
  ArtifactEditTargetInput,
  CompositeEditPreview,
  CompositeEditRequest,
  EditOperation,
  EditTarget,
  EditTransaction,
  EditorTimelineEditTarget,
  EditorTimelineEditTargetInput,
  WorkflowOperation,
} from "../domain/editing.js";
import { assertValidMaskConfiguration } from "../domain/editing.js";
import type { ProjectSnapshot } from "../domain/project.js";
import type { ContextRevision, RationalTime } from "../domain/primitives.js";
import type { TimelineDiff } from "../domain/diff.js";
import type { VerificationCheck, VerificationEngine, VerificationPolicy } from "../domain/verification.js";
import { sameRevision } from "../context/revision.js";
import { MediaAnalysisService, type PostWriteAnalysisRequirements } from "../application/media-analysis-service.js";
import { ProjectService } from "../application/project-service.js";
import type { RuntimeOptions } from "../application/runtime-options.js";
import type { TransactionStore } from "../application/transaction-store.js";
import { addRationalTimes, parseRational } from "../timeline/rational-time.js";
import { assertValidVerificationPolicy } from "../verification/verification.js";

export class EditService {
  private readonly editPreviews = new Map<string, CompositeEditPreview>();
  // Historical transaction snapshots stay immutable. Only an observed, verified
  // restoration can rebind an earlier Undo to the newly advanced revision.
  private readonly undoGuards = new Map<string, { target: EditTarget; revision: ContextRevision; digest: string; artifactDigest?: string }>();
  private readonly undoBaselines = new Map<string, string | undefined>();
  private readonly consumedUndos = new Set<string>();

  public constructor(
    private readonly adapter: EditorPort,
    private readonly project: ProjectService,
    private readonly analysis: MediaAnalysisService,
    private readonly verificationEngine: VerificationEngine,
    private readonly options: RuntimeOptions,
    private readonly transactions: TransactionStore,
  ) {}

  public async edit(operation: EditOperation, policy: VerificationPolicy = {}): Promise<EditTransaction> {
    const verificationPolicy = structuredClone(policy);
    assertValidVerificationPolicy(verificationPolicy);
    const before = await this.project.inspectProject();
    const capabilities = await this.adapter.getCapabilities();
    const target = await this.defaultTarget(before, capabilities);
    return this.editWithTarget(operation, verificationPolicy, target, before, capabilities);
  }

  public async editArtifact(
    targetInput: ArtifactEditTargetInput,
    operation: EditOperation,
    policy: VerificationPolicy = {},
  ): Promise<EditTransaction> {
    const target = await this.artifactTarget(targetInput);
    return this.editWithTarget(operation, policy, target);
  }

  public async editTimeline(
    targetInput: EditorTimelineEditTargetInput,
    operation: EditOperation,
    policy: VerificationPolicy = {},
  ): Promise<EditTransaction> {
    const target = this.timelineTarget(targetInput);
    if (!operation.baseRevision) throw new Error("INVALID_TIMELINE_TARGET: baseRevision is required");
    return this.editWithTarget(operation, policy, target);
  }

  private async editWithTarget(
    operation: EditOperation,
    policy: VerificationPolicy,
    target: EditTarget,
    existingBefore?: ProjectSnapshot,
    existingCapabilities?: Awaited<ReturnType<EditorPort["getCapabilities"]>>,
  ): Promise<EditTransaction> {
    const verificationPolicy = structuredClone(policy);
    assertValidVerificationPolicy(verificationPolicy);
    const before = existingBefore ?? await this.project.inspectProject();
    const capabilities = existingCapabilities ?? await this.adapter.getCapabilities();
    this.assertTarget(target, before);
    if (operation.baseRevision && !sameRevision(operation.baseRevision, before.revision)) {
      throw new Error("STALE_CONTEXT: operation base revision does not match current editor state");
    }
    assertValidWorkflowOperation(operation);

    this.assertSurfaceCapability(target, capabilities.editor);
    if (!capabilities.editor.timelineSnapshotRead || !capabilities.editor.readAfterWrite || !capabilities.editor.rollback) {
      throw new Error(`CAPABILITY_UNAVAILABLE: ${target.kind === "artifact" ? "artifact" : "editor timeline"} mutation requires snapshot, read-after-write, and rollback`);
    }
    const beforeArtifactDigest = await this.readArtifactDigest(target);
    const appliedRevision = await this.adapter.apply(operation, before.revision);
    let attemptedAfter: ProjectSnapshot;
    try {
      attemptedAfter = await this.project.inspectProject();
    } catch (readError) {
      try {
        await this.restoreAndVerify(before, appliedRevision, target, beforeArtifactDigest);
      } catch (rollbackError) {
        throw new Error(`READ_AFTER_WRITE_FAILED: compensating rollback failed (${String(readError)}; ${String(rollbackError)})`);
      }
      throw new Error(`READ_AFTER_WRITE_FAILED: canonical state was restored (${String(readError)})`);
    }
    const artifactDigest = await this.readArtifactDigest(target);
    const transaction: EditTransaction = {
      id: `txn-${randomUUID()}`,
      target: structuredClone(target),
      ...(artifactDigest ? { artifactDigest } : {}),
      operation,
      intent: operation.type,
      planned: [operation],
      applied: [operation],
      baseRevision: before.revision,
      before,
      after: attemptedAfter,
      attemptedAfter,
      diff: diffSnapshots(before, attemptedAfter),
      verificationPolicy,
      status: "APPLIED",
    };
    try {
      await this.reanalyzeForVerification(transaction, verificationPolicy);
    } catch (error) {
      await this.restoreAndVerify(before, attemptedAfter.revision, target, beforeArtifactDigest);
      throw new Error(`ANALYSIS_FAILED: post-write verification analysis failed (${String(error)})`);
    }
    try {
      transaction.verification = {
        ...(await this.verificationEngine.verify(transaction, verificationPolicy)),
        target: structuredClone(target),
      };
    } catch (verificationError) {
      try {
        await this.restoreAndVerify(before, attemptedAfter.revision, target, beforeArtifactDigest);
      } catch (rollbackError) {
        throw new Error(`VERIFICATION_FAILED: compensating rollback failed (${String(verificationError)}; ${String(rollbackError)})`);
      }
      throw new Error(`VERIFICATION_FAILED: canonical state was restored (${String(verificationError)})`);
    }
    if (transaction.verification.passed) {
      transaction.status = "VERIFIED";
    } else {
      transaction.after = await this.restoreAndVerify(before, attemptedAfter.revision, target, beforeArtifactDigest);
      transaction.status = "ROLLED_BACK";
    }
    this.rememberTransaction(transaction, beforeArtifactDigest);
    return transaction;
  }

  public async previewEdit(request: CompositeEditRequest): Promise<CompositeEditPreview> {
    const verification = structuredClone(request.verification ?? {});
    assertValidVerificationPolicy(verification);
    const before = await this.project.inspectProject();
    const capabilities = await this.adapter.getCapabilities();
    const target = await this.defaultTarget(before, capabilities);
    return this.previewEditWithTarget(request, target, before, capabilities);
  }

  public async previewArtifactEdit(
    targetInput: ArtifactEditTargetInput,
    request: CompositeEditRequest,
  ): Promise<CompositeEditPreview> {
    const target = await this.artifactTarget(targetInput);
    return this.previewEditWithTarget(request, target);
  }

  public async previewTimelineEdit(
    targetInput: EditorTimelineEditTargetInput,
    request: CompositeEditRequest,
  ): Promise<CompositeEditPreview> {
    const target = this.timelineTarget(targetInput);
    return this.previewEditWithTarget(request, target);
  }

  private async previewEditWithTarget(
    request: CompositeEditRequest,
    target: EditTarget,
    existingBefore?: ProjectSnapshot,
    existingCapabilities?: Awaited<ReturnType<EditorPort["getCapabilities"]>>,
  ): Promise<CompositeEditPreview> {
    const verification = structuredClone(request.verification ?? {});
    assertValidVerificationPolicy(verification);
    const before = existingBefore ?? await this.project.inspectProject();
    const capabilities = existingCapabilities ?? await this.adapter.getCapabilities();
    this.assertTarget(target, before);
    if (!sameRevision(request.baseRevision, before.revision)) {
      throw new Error("STALE_CONTEXT: preview base revision does not match current editor state");
    }
    if (request.operations.length === 0) throw new Error("INVALID_OPERATION: composite edit requires operations");
    request.operations.forEach(assertValidWorkflowOperation);
    await this.assertCompositeCapabilities(request.operations, target.kind, capabilities.editor);
    if (!this.adapter.previewTransaction) {
      throw new Error("CAPABILITY_UNAVAILABLE: editor composite transaction preview");
    }
    const expectedAfter = await this.adapter.previewTransaction(request.operations, before.revision);
    const artifactDigest = await this.readArtifactDigest(target);
    const previewToken = `preview-${randomUUID()}`;
    const preview: CompositeEditPreview = {
      previewToken,
      target: structuredClone(target),
      baseRevision: structuredClone(before.revision),
      ...(artifactDigest ? { artifactDigest } : {}),
      operations: structuredClone(request.operations),
      expectedDiff: diffSnapshots(before, expectedAfter),
      warnings: [],
      expiresAt: new Date(this.now() + (this.options.previewTtlMs ?? 30_000)).toISOString(),
      verification,
    };
    this.pruneEditPreviews();
    const maxActivePreviews = Number.isInteger(this.options.maxActivePreviews) && this.options.maxActivePreviews! > 0
      ? this.options.maxActivePreviews!
      : 128;
    while (this.editPreviews.size >= maxActivePreviews) {
      const oldestToken = this.editPreviews.keys().next().value;
      if (oldestToken === undefined) break;
      this.editPreviews.delete(oldestToken);
    }
    this.editPreviews.set(previewToken, preview);
    return structuredClone(preview);
  }

  public async executeEdit(previewToken: string, policy: VerificationPolicy = {}): Promise<EditTransaction> {
    const requestedPolicy = structuredClone(policy);
    assertValidVerificationPolicy(requestedPolicy);
    const preview = this.editPreviews.get(previewToken);
    if (!preview) throw new Error(`PREVIEW_TOKEN_INVALID: unknown or already used preview ${previewToken}`);
    this.editPreviews.delete(previewToken);
    if (this.now() > Date.parse(preview.expiresAt)) {
      throw new Error("PREVIEW_TOKEN_EXPIRED: composite edit preview has expired");
    }
    const before = await this.project.inspectProject();
    const currentArtifactDigest = await this.readArtifactDigest(preview.target);
    if (preview.target.kind === "artifact"
      && preview.artifactDigest !== undefined
      && currentArtifactDigest !== preview.artifactDigest) {
      throw new Error("ARTIFACT_SOURCE_CHANGED: FCPXML artifact digest changed before execution");
    }
    if (!sameRevision(preview.baseRevision, before.revision)) {
      throw new Error("STALE_CONTEXT: preview base revision does not match current editor state");
    }
    this.assertTarget(preview.target, before);
    preview.operations.forEach(assertValidWorkflowOperation);
    const executionCapabilities = (await this.adapter.getCapabilities()).editor;
    await this.assertCompositeCapabilities(preview.operations, preview.target.kind, executionCapabilities);
    if (!this.adapter.applyTransaction) {
      throw new Error("CAPABILITY_UNAVAILABLE: editor composite transaction execution");
    }
    const verificationPolicy = Object.keys(requestedPolicy).length > 0
      ? { ...structuredClone(preview.verification ?? {}), ...requestedPolicy }
      : structuredClone(preview.verification ?? {});
    assertValidVerificationPolicy(verificationPolicy);
    try {
      await this.adapter.applyTransaction(preview.operations, before.revision);
    } catch (error) {
      const partiallyApplied = await this.project.inspectProject();
      if (!sameRevision(partiallyApplied.revision, before.revision)) {
        try {
          await this.restoreAndVerify(before, partiallyApplied.revision, preview.target, currentArtifactDigest);
        } catch (rollbackError) {
          throw new Error(`TRANSACTION_FAILED: ${String(error)}; rollback failed: ${String(rollbackError)}`);
        }
      }
      throw new Error(`TRANSACTION_FAILED: ${String(error)}; transaction was rolled back`);
    }
    const attemptedAfter = await this.project.inspectProject();
    const artifactDigest = await this.readArtifactDigest(preview.target);
    const transaction: EditTransaction = {
      id: `txn-${randomUUID()}`,
      target: structuredClone(preview.target),
      ...(artifactDigest ? { artifactDigest } : {}),
      intent: "composite-edit",
      planned: structuredClone(preview.operations),
      applied: structuredClone(preview.operations),
      baseRevision: before.revision,
      before,
      after: attemptedAfter,
      attemptedAfter,
      diff: diffSnapshots(before, attemptedAfter),
      verificationPolicy,
      status: "APPLIED",
    };
    const markerOperation = preview.operations.length === 1 && preview.operations[0]?.type === "add-marker"
      && preview.target.kind === "editor.timeline"
      && executionCapabilities.markerIdentityMode === "editor-assigned"
      && executionCapabilities.semanticOperations?.["add-marker"] === true
      ? preview.operations[0] : undefined;
    const authorizedDiffCheck: VerificationCheck | undefined = sameDiffContent(
      transaction.diff, preview.expectedDiff, markerOperation?.marker.id, before.timeline.markers.map((marker) => marker.id),
    )
      ? undefined
      : {
        name: "authorized-diff",
        passed: false,
        status: "failed",
        reason: "UNAUTHORIZED_DIFF",
        expected: structuredClone(preview.expectedDiff),
        observed: structuredClone(transaction.diff),
        detail: "canonical diff contains changes outside the preview-authorized operations",
      };
    try {
      await this.reanalyzeForVerification(transaction, verificationPolicy);
    } catch (error) {
      await this.restoreAndVerify(before, attemptedAfter.revision, preview.target, currentArtifactDigest);
      throw new Error(`ANALYSIS_FAILED: post-write verification analysis failed (${String(error)})`);
    }
    try {
      transaction.verification = {
        ...(await this.verificationEngine.verify(transaction, verificationPolicy)),
        target: structuredClone(preview.target),
      };
    } catch (verificationError) {
      try {
        await this.restoreAndVerify(before, attemptedAfter.revision, preview.target, currentArtifactDigest);
      } catch (rollbackError) {
        throw new Error(`VERIFICATION_FAILED: compensating rollback failed (${String(verificationError)}; ${String(rollbackError)})`);
      }
      throw new Error(`VERIFICATION_FAILED: canonical state was restored (${String(verificationError)})`);
    }
    if (authorizedDiffCheck && transaction.verification) {
      transaction.verification = {
        ...transaction.verification,
        passed: false,
        checks: [...transaction.verification.checks, authorizedDiffCheck],
      };
    }
    if (transaction.verification.passed) {
      transaction.status = "VERIFIED";
    } else {
      transaction.after = await this.restoreAndVerify(before, attemptedAfter.revision, preview.target, currentArtifactDigest);
      transaction.status = "ROLLED_BACK";
    }
    this.rememberTransaction(transaction, currentArtifactDigest);
    return transaction;
  }

  public getDiff(transactionId: string): TimelineDiff {
    return this.getTransaction(transactionId).diff;
  }

  public getTransaction(transactionId: string): EditTransaction {
    return this.transactions.get(transactionId);
  }

  public async verifyTransaction(transactionId: string): Promise<NonNullable<EditTransaction["verification"]>> {
    return this.getTransaction(transactionId).verification!;
  }

  private async reanalyzeForVerification(
    transaction: EditTransaction,
    policy: VerificationPolicy,
  ): Promise<void> {
    const requirements = postWriteAnalysisRequirements(policy);
    if (!Object.values(requirements).some(Boolean)) return;
    transaction.attemptedAfter = await this.analysis.reanalyzeAffectedRanges(transaction, requirements);
    transaction.after = transaction.attemptedAfter;
  }

  public async undo(transactionId: string): Promise<ProjectSnapshot> {
    const transaction = this.getTransaction(transactionId);
    if (this.consumedUndos.has(transactionId) || transaction.status === "ROLLED_BACK") {
      throw new Error(`STALE_CONTEXT: transaction ${transactionId} restoration was already attempted`);
    }
    const guard = this.undoGuards.get(transactionId);
    const expectedArtifactDigest = guard?.artifactDigest ?? transaction.artifactDigest;
    const currentArtifactDigest = await this.readArtifactDigest(transaction.target);
    if (transaction.target?.kind === "artifact"
      && expectedArtifactDigest !== undefined
      && currentArtifactDigest !== expectedArtifactDigest) {
      throw new Error("ARTIFACT_SOURCE_CHANGED: FCPXML artifact digest changed after transaction");
    }
    const current = await this.project.inspectProject();
    if (current.projectId !== transaction.before.projectId || current.timeline.id !== transaction.before.timeline.id) {
      throw new Error(
        `TARGET_MISMATCH: cannot undo ${transaction.before.projectId}/${transaction.before.timeline.id} while ${current.projectId}/${current.timeline.id} is active`,
      );
    }
    if (!sameRevision(current.revision, guard?.revision ?? transaction.after.revision)
      || canonicalSnapshotDigest(current) !== (guard?.digest ?? canonicalSnapshotDigest(transaction.after))) {
      throw new Error(`STALE_CONTEXT: transaction ${transactionId} changed after edit`);
    }
    if (this.consumedUndos.has(transactionId)) throw new Error(`STALE_CONTEXT: transaction ${transactionId} restoration was already attempted`);
    this.consumedUndos.add(transactionId);
    return this.restoreAndVerify(transaction.before, current.revision, transaction.target, this.undoBaselines.get(transactionId));
  }

  private rememberTransaction(transaction: EditTransaction, beforeArtifactDigest?: string): void {
    this.transactions.set(transaction);
    this.undoBaselines.set(transaction.id, beforeArtifactDigest);
    if (transaction.status === "VERIFIED" && transaction.target) {
      this.undoGuards.set(transaction.id, { target: structuredClone(transaction.target), revision: structuredClone(transaction.after.revision),
        digest: canonicalSnapshotDigest(transaction.after), ...(transaction.artifactDigest ? { artifactDigest: transaction.artifactDigest } : {}) });
    }
  }

  private async restoreAndVerify(
    before: ProjectSnapshot,
    expectedRevision: ContextRevision,
    target: EditTarget | undefined,
    beforeArtifactDigest?: string,
  ): Promise<ProjectSnapshot> {
    await this.adapter.restore(before, expectedRevision);
    const restored = await this.project.inspectProject();
    this.assertRestored(before, restored);
    if (restored.revision.id === expectedRevision.id || restored.revision.sequence <= expectedRevision.sequence) {
      throw new Error("ROLLBACK_FAILED: restoration did not advance the canonical revision");
    }
    const artifactDigest = await this.readArtifactDigest(target);
    const digest = canonicalSnapshotDigest(before);
    for (const [id, guard] of this.undoGuards) {
      if (!this.consumedUndos.has(id) && isDeepStrictEqual(guard.target, target)
        && sameRevision(guard.revision, before.revision) && guard.digest === digest
        && (target?.kind !== "artifact" || guard.artifactDigest === beforeArtifactDigest)) {
        this.undoGuards.set(id, { ...guard, revision: structuredClone(restored.revision),
          ...(artifactDigest ? { artifactDigest } : {}) });
      }
    }
    return restored;
  }

  private assertRestored(expected: ProjectSnapshot, actual: ProjectSnapshot): void {
    if (canonicalSnapshotDigest(expected) !== canonicalSnapshotDigest(actual)) {
      throw new Error("ROLLBACK_FAILED: restored canonical digest does not match pre-edit state");
    }
  }

  private async assertCompositeCapabilities(
    operations: WorkflowOperation[],
    targetKind?: EditTarget["kind"],
    existingCapabilities?: Awaited<ReturnType<EditorPort["getCapabilities"]>>["editor"],
  ): Promise<void> {
    const capabilities = existingCapabilities ?? (await this.adapter.getCapabilities()).editor;
    const supportedTransaction = capabilities.compositeTransactions
      || (operations.length === 1 && capabilities.singleOperationTransactions === true);
    if (!supportedTransaction || !capabilities.readAfterWrite || !capabilities.rollback) {
      throw new Error("CAPABILITY_UNAVAILABLE: editor composite transactions");
    }
    if (operations.some((operation) => operation.type === "media.import") && !capabilities.mediaImport) {
      throw new Error("CAPABILITY_UNAVAILABLE: media import");
    }
    if (operations.some((operation) => operation.type === "timeline.media.add") && !capabilities.mediaPlacement) {
      throw new Error("CAPABILITY_UNAVAILABLE: timeline media placement");
    }
    if (operations.some((operation) => operation.type === "timeline.picture-in-picture.add") && !capabilities.pictureInPicture) {
      throw new Error("CAPABILITY_UNAVAILABLE: picture-in-picture placement");
    }
    if (operations.some((operation) => operation.type === "timeline.title.add")
      && (!capabilities.titlePlacement || !capabilities.assetDiscovery)) {
      throw new Error("CAPABILITY_UNAVAILABLE: timeline title placement");
    }
    if (operations.some((operation) => operation.type !== "media.import")) {
      if (targetKind === "artifact" && !capabilities.timelineArtifactWrite) {
        throw new Error("CAPABILITY_UNAVAILABLE: artifact mutation");
      }
      if (targetKind === "editor.timeline" && !capabilities.timelineWrite) {
        throw new Error("CAPABILITY_UNAVAILABLE: editor timeline mutation");
      }
      if (!targetKind && !capabilities.timelineWrite && !capabilities.timelineArtifactWrite) {
        throw new Error("CAPABILITY_UNAVAILABLE: editor timeline mutation");
      }
    }
    if (operations.some((operation) => operation.type === "timeline.media.move") && !capabilities.clipMove) {
      throw new Error("CAPABILITY_UNAVAILABLE: timeline media move");
    }
    if (operations.some((operation) => operation.type === "timeline.media.replace") && !capabilities.clipReplace) {
      throw new Error("CAPABILITY_UNAVAILABLE: timeline media replace");
    }
    if (operations.some((operation) => operation.type === "timeline.media.remove") && !capabilities.clipRemoval) {
      throw new Error("CAPABILITY_UNAVAILABLE: timeline media removal");
    }
    if (operations.some((operation) => operation.type === "timeline.transition.add")
      && (!capabilities.transitionPlacement || !capabilities.assetDiscovery)) {
      throw new Error("CAPABILITY_UNAVAILABLE: timeline transition placement");
    }
    const maskOperations = operations.filter(
      (operation): operation is Extract<WorkflowOperation, { type: "timeline.mask.add" }> => operation.type === "timeline.mask.add",
    );
    if (maskOperations.some((operation) => operation.mask.mode !== "person-cutout") && !capabilities.masking) {
      throw new Error("CAPABILITY_UNAVAILABLE: masking");
    }
    if (maskOperations.some((operation) => operation.mask.mode === "person-cutout") && !capabilities.personCutout) {
      throw new Error("CAPABILITY_UNAVAILABLE: person cutout");
    }
    if (operations.some((operation) => operation.type === "timeline.audio.attach") && !capabilities.audioAttachment) {
      throw new Error("CAPABILITY_UNAVAILABLE: timeline audio attachment");
    }
    if (operations.some((operation) => operation.type === "timeline.audio.mix") && !capabilities.audioMixing) {
      throw new Error("CAPABILITY_UNAVAILABLE: timeline audio mixing");
    }
    if (operations.some((operation) => operation.type === "reduce-noise") && !capabilities.noiseReduction) {
      throw new Error("CAPABILITY_UNAVAILABLE: noise reduction effect");
    }
    if (operations.some((operation) => operation.type === "set-color-correction") && !capabilities.colorCorrection) {
      throw new Error("CAPABILITY_UNAVAILABLE: color correction");
    }
  }

  private async defaultTarget(
    before: ProjectSnapshot,
    capabilities: Awaited<ReturnType<EditorPort["getCapabilities"]>>,
  ): Promise<EditTarget> {
    if (capabilities.editor.timelineArtifactWrite && !capabilities.editor.timelineWrite) {
      if (!this.adapter.getManagedArtifact) {
        throw new Error("CAPABILITY_UNAVAILABLE: managed FCPXML artifact");
      }
      return this.artifactDescriptor(await this.adapter.getManagedArtifact());
    }
    return {
      kind: "editor.timeline",
      projectId: before.projectId,
      sequenceId: before.timeline.id,
    };
  }

  private async artifactTarget(input: ArtifactEditTargetInput): Promise<ArtifactEditTarget> {
    if (!input.artifactPath.trim()) throw new Error("INVALID_ARTIFACT_TARGET: artifactPath is required");
    if (!this.adapter.getManagedArtifact) {
      throw new Error("CAPABILITY_UNAVAILABLE: managed FCPXML artifact");
    }
    const managed = await this.adapter.getManagedArtifact();
    if (resolvePath(managed.path) !== resolvePath(input.artifactPath.trim())) {
      throw new Error(`TARGET_MISMATCH: requested artifact ${input.artifactPath} is not managed by this adapter`);
    }
    return this.artifactDescriptor(managed);
  }

  private artifactDescriptor(artifact: { id: string; path: string }): ArtifactEditTarget {
    return { kind: "artifact", artifactId: artifact.id, artifactPath: artifact.path };
  }

  private async readArtifactDigest(target: EditTarget | undefined): Promise<string | undefined> {
    if (!target || target.kind !== "artifact" || !this.adapter.getManagedArtifactDigest) return undefined;
    return this.adapter.getManagedArtifactDigest();
  }

  private timelineTarget(input: EditorTimelineEditTargetInput): EditorTimelineEditTarget {
    const projectId = input.projectId.trim();
    const sequenceId = input.sequenceId.trim();
    if (!projectId || !sequenceId) {
      throw new Error("INVALID_TIMELINE_TARGET: projectId and sequenceId are required");
    }
    return { kind: "editor.timeline", projectId, sequenceId };
  }

  private assertTarget(target: EditTarget, snapshot: ProjectSnapshot): void {
    if (target.kind === "editor.timeline"
      && (target.projectId !== snapshot.projectId || target.sequenceId !== snapshot.timeline.id)) {
      throw new Error(
        `TARGET_MISMATCH: requested ${target.projectId}/${target.sequenceId} while ${snapshot.projectId}/${snapshot.timeline.id} is active`,
      );
    }
  }

  private assertSurfaceCapability(
    target: EditTarget,
    capabilities: Awaited<ReturnType<EditorPort["getCapabilities"]>>["editor"],
  ): void {
    if (target.kind === "artifact" && !capabilities.timelineArtifactWrite) {
      throw new Error("CAPABILITY_UNAVAILABLE: artifact mutation");
    }
    if (target.kind === "editor.timeline" && !capabilities.timelineWrite) {
      throw new Error("CAPABILITY_UNAVAILABLE: editor timeline mutation");
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private pruneEditPreviews(): void {
    const now = this.now();
    for (const [previewToken, preview] of this.editPreviews) {
      if (now > Date.parse(preview.expiresAt)) this.editPreviews.delete(previewToken);
    }
  }
}

function postWriteAnalysisRequirements(policy: VerificationPolicy): PostWriteAnalysisRequirements {
  const assertions = policy.assertions ?? [];
  return {
    speech: policy.requireSpeechContinuity === true,
    audio: policy.maxTruePeakDb !== undefined
      || policy.targetLufs !== undefined
      || assertions.some((assertion) => assertion.type === "audio-audibility" || assertion.type === "audio-loudness"),
    noise: assertions.some((assertion) => assertion.type === "audio-noise"),
    visual: assertions.some((assertion) => assertion.type === "visual-content"),
  };
}

function sameDiffContent(left: TimelineDiff, right: TimelineDiff, requestedMarkerId?: string, existingMarkerIds: string[] = []): boolean {
  const actual = structuredClone(left);
  const expectedMarker = right.markerChanges[0];
  const actualMarker = actual.markerChanges[0];
  const expectedChange = right.changes.filter((change) => change.scope === "marker");
  const actualChange = actual.changes.filter((change) => change.scope === "marker");
  if (requestedMarkerId && right.markerChanges.length === 1 && actual.markerChanges.length === 1
    && expectedMarker?.type === "MARKER_ADDED" && actualMarker?.type === "MARKER_ADDED"
    && expectedMarker.itemId === requestedMarkerId && expectedMarker.marker.id === requestedMarkerId
    && expectedMarker.after?.id === requestedMarkerId && !expectedMarker.before
    && actualMarker.itemId && actualMarker.marker.id === actualMarker.itemId && actualMarker.after?.id === actualMarker.itemId && !actualMarker.before
    && !existingMarkerIds.includes(requestedMarkerId) && !existingMarkerIds.includes(actualMarker.itemId)
    && expectedChange.length === 1 && actualChange.length === 1
    && expectedChange[0]?.type === "MARKER_ADDED" && expectedChange[0].itemId === requestedMarkerId && expectedChange[0].after?.id === requestedMarkerId
    && actualChange[0]?.type === "MARKER_ADDED" && actualChange[0].itemId === actualMarker.itemId && actualChange[0].after?.id === actualMarker.itemId) {
    actualMarker.itemId = requestedMarkerId;
    actualMarker.marker.id = requestedMarkerId;
    actualMarker.after.id = requestedMarkerId;
    actualChange[0].itemId = requestedMarkerId;
    actualChange[0].after!.id = requestedMarkerId;
  }
  const comparable = (diff: TimelineDiff) => {
    const normalized = structuredClone(diff);
    const normalize = (value: RationalTime): RationalTime => addRationalTimes(value, { value: "0", timescale: "1" }, "INVALID_PROJECT_STATE");
    const normalizeItem = (value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const item = value as Record<string, unknown>;
      for (const key of ["startTime", "durationTime", "sourceStartTime"]) {
        if (item[key] !== undefined) item[key] = normalize(item[key] as RationalTime);
      }
    };
    for (const change of [...normalized.added, ...normalized.removed, ...normalized.modified]) {
      normalizeItem(change.before);
      normalizeItem(change.after);
    }
    for (const change of [...normalized.markerChanges, ...normalized.captionChanges, ...normalized.storyElementChanges]) {
      normalizeItem(change.before);
      normalizeItem(change.after);
      if ("marker" in change) normalizeItem(change.marker);
      if ("caption" in change) normalizeItem(change.caption);
      if ("element" in change) normalizeItem(change.element);
    }
    for (const change of normalized.changes) {
      if (change.scope !== "media") {
        normalizeItem(change.before);
        normalizeItem(change.after);
      }
    }
    for (const range of normalized.affectedRanges) normalizeItem(range);
    normalized.durationDeltaTime = normalize(normalized.durationDeltaTime);
    if (normalized.playheadChange?.before) normalized.playheadChange.before = normalize(normalized.playheadChange.before);
    if (normalized.playheadChange?.after) normalized.playheadChange.after = normalize(normalized.playheadChange.after);
    const { from: _from, to: _to, provenance, ...content } = normalized;
    return {
      target: provenance ? { projectId: provenance.projectId, sequenceId: provenance.sequenceId } : undefined,
      ...content,
    };
  };
  try {
    return JSON.stringify(comparable(actual)) === JSON.stringify(comparable(right));
  } catch {
    return false;
  }
}

function assertValidWorkflowOperation(operation: WorkflowOperation): void {
  if (operation.type === "timeline.mask.add") {
    if (!operation.occurrenceId.trim()) throw new Error("INVALID_OPERATION: mask occurrenceId is required");
    assertValidMaskConfiguration(operation.mask);
    return;
  }
  if (operation.type !== "trim-clip") return;
  if (!Number.isFinite(operation.duration) || operation.duration <= 0) {
    throw new Error("INVALID_OPERATION: clip duration must be positive");
  }
  if (!operation.durationTime) return;
  const duration = parseRational(operation.durationTime, "INVALID_OPERATION");
  if (duration.value <= 0n) {
    throw new Error("INVALID_OPERATION: clip duration must be positive");
  }
}
