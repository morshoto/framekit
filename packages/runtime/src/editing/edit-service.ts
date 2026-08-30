import { randomUUID } from "node:crypto";
import { diffSnapshots } from "../timeline/snapshot-diff.js";
import { canonicalSnapshotDigest } from "../timeline/snapshot-digest.js";
import type { EditorPort } from "../domain/ports.js";
import type {
  CompositeEditPreview,
  CompositeEditRequest,
  EditOperation,
  EditTransaction,
  WorkflowOperation,
} from "../domain/editing.js";
import type { ProjectSnapshot } from "../domain/project.js";
import type { TimelineDiff } from "../domain/diff.js";
import type { VerificationEngine, VerificationPolicy } from "../domain/verification.js";
import { sameRevision } from "../context/revision.js";
import { MediaAnalysisService } from "../application/media-analysis-service.js";
import { ProjectService } from "../application/project-service.js";
import type { RuntimeOptions } from "../application/runtime-options.js";
import { TransactionStore } from "../application/transaction-store.js";

export class EditService {
  private readonly editPreviews = new Map<string, CompositeEditPreview>();

  public constructor(
    private readonly adapter: EditorPort,
    private readonly project: ProjectService,
    private readonly analysis: MediaAnalysisService,
    private readonly verificationEngine: VerificationEngine,
    private readonly options: RuntimeOptions,
    private readonly transactions: TransactionStore,
  ) {}

  public async edit(operation: EditOperation, policy: VerificationPolicy = {}): Promise<EditTransaction> {
    const before = await this.project.inspectProject();
    if (operation.baseRevision && !sameRevision(operation.baseRevision, before.revision)) {
      throw new Error("STALE_CONTEXT: operation base revision does not match current editor state");
    }

    const capabilities = await this.adapter.getCapabilities();
    if (!capabilities.editor.timelineWrite && !capabilities.editor.timelineArtifactWrite) {
      throw new Error("CAPABILITY_UNAVAILABLE: editor timeline mutation");
    }
    if (!capabilities.editor.timelineSnapshotRead || !capabilities.editor.readAfterWrite || !capabilities.editor.rollback) {
      throw new Error("CAPABILITY_UNAVAILABLE: editor timeline mutation requires snapshot, read-after-write, and rollback");
    }
    const appliedRevision = await this.adapter.apply(operation, before.revision);
    let attemptedAfter: ProjectSnapshot;
    try {
      attemptedAfter = await this.project.inspectProject();
    } catch (readError) {
      try {
        await this.adapter.restore(before, appliedRevision);
        this.assertRestored(before, await this.project.inspectProject());
      } catch (rollbackError) {
        throw new Error(`READ_AFTER_WRITE_FAILED: compensating rollback failed (${String(readError)}; ${String(rollbackError)})`);
      }
      throw new Error(`READ_AFTER_WRITE_FAILED: canonical state was restored (${String(readError)})`);
    }
    const transaction: EditTransaction = {
      id: `txn-${randomUUID()}`,
      operation,
      intent: operation.type,
      planned: [operation],
      applied: [operation],
      baseRevision: before.revision,
      before,
      after: attemptedAfter,
      attemptedAfter,
      diff: diffSnapshots(before, attemptedAfter),
      verificationPolicy: structuredClone(policy),
      status: "APPLIED",
    };
    try {
      transaction.attemptedAfter = await this.analysis.reanalyzeAffectedRanges(transaction);
      transaction.after = transaction.attemptedAfter;
    } catch (error) {
      await this.adapter.restore(before, attemptedAfter.revision);
      this.assertRestored(before, await this.project.inspectProject());
      throw new Error(`ANALYSIS_FAILED: post-write verification analysis failed (${String(error)})`);
    }
    try {
      transaction.verification = await this.verificationEngine.verify(transaction, policy);
    } catch (verificationError) {
      try {
        await this.adapter.restore(before, attemptedAfter.revision);
        this.assertRestored(before, await this.project.inspectProject());
      } catch (rollbackError) {
        throw new Error(`VERIFICATION_FAILED: compensating rollback failed (${String(verificationError)}; ${String(rollbackError)})`);
      }
      throw new Error(`VERIFICATION_FAILED: canonical state was restored (${String(verificationError)})`);
    }
    if (transaction.verification.passed) {
      transaction.status = "VERIFIED";
    } else {
      await this.adapter.restore(before, attemptedAfter.revision);
      transaction.after = await this.project.inspectProject();
      this.assertRestored(before, transaction.after);
      transaction.status = "ROLLED_BACK";
    }
    this.transactions.set(transaction);
    return transaction;
  }

  public async previewEdit(request: CompositeEditRequest): Promise<CompositeEditPreview> {
    const before = await this.project.inspectProject();
    if (!sameRevision(request.baseRevision, before.revision)) {
      throw new Error("STALE_CONTEXT: preview base revision does not match current editor state");
    }
    if (request.operations.length === 0) throw new Error("INVALID_OPERATION: composite edit requires operations");
    await this.assertCompositeCapabilities(request.operations);
    if (!this.adapter.previewTransaction) {
      throw new Error("CAPABILITY_UNAVAILABLE: editor composite transaction preview");
    }
    const expectedAfter = await this.adapter.previewTransaction(request.operations, before.revision);
    const previewToken = `preview-${randomUUID()}`;
    const preview: CompositeEditPreview = {
      previewToken,
      baseRevision: structuredClone(before.revision),
      operations: structuredClone(request.operations),
      expectedDiff: diffSnapshots(before, expectedAfter),
      warnings: [],
      expiresAt: new Date(this.now() + (this.options.previewTtlMs ?? 30_000)).toISOString(),
      verification: structuredClone(request.verification ?? {}),
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
    const preview = this.editPreviews.get(previewToken);
    if (!preview) throw new Error(`PREVIEW_TOKEN_INVALID: unknown or already used preview ${previewToken}`);
    this.editPreviews.delete(previewToken);
    if (this.now() > Date.parse(preview.expiresAt)) {
      throw new Error("PREVIEW_TOKEN_EXPIRED: composite edit preview has expired");
    }
    const before = await this.project.inspectProject();
    if (!sameRevision(preview.baseRevision, before.revision)) {
      throw new Error("STALE_CONTEXT: preview base revision does not match current editor state");
    }
    await this.assertCompositeCapabilities(preview.operations);
    if (!this.adapter.applyTransaction) {
      throw new Error("CAPABILITY_UNAVAILABLE: editor composite transaction execution");
    }
    const verificationPolicy = Object.keys(policy).length > 0
      ? { ...structuredClone(preview.verification ?? {}), ...structuredClone(policy) }
      : structuredClone(preview.verification ?? {});
    try {
      await this.adapter.applyTransaction(preview.operations, before.revision);
    } catch (error) {
      const partiallyApplied = await this.project.inspectProject();
      if (!sameRevision(partiallyApplied.revision, before.revision)) {
        try {
          await this.adapter.restore(before, partiallyApplied.revision);
        } catch (rollbackError) {
          throw new Error(`TRANSACTION_FAILED: ${String(error)}; rollback failed: ${String(rollbackError)}`);
        }
      }
      throw new Error(`TRANSACTION_FAILED: ${String(error)}; transaction was rolled back`);
    }
    const attemptedAfter = await this.project.inspectProject();
    const transaction: EditTransaction = {
      id: `txn-${randomUUID()}`,
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
    try {
      transaction.attemptedAfter = await this.analysis.reanalyzeAffectedRanges(transaction);
      transaction.after = transaction.attemptedAfter;
    } catch (error) {
      await this.adapter.restore(before, attemptedAfter.revision);
      this.assertRestored(before, await this.project.inspectProject());
      throw new Error(`ANALYSIS_FAILED: post-write verification analysis failed (${String(error)})`);
    }
    try {
      transaction.verification = await this.verificationEngine.verify(transaction, verificationPolicy);
    } catch (verificationError) {
      try {
        await this.adapter.restore(before, attemptedAfter.revision);
        this.assertRestored(before, await this.project.inspectProject());
      } catch (rollbackError) {
        throw new Error(`VERIFICATION_FAILED: compensating rollback failed (${String(verificationError)}; ${String(rollbackError)})`);
      }
      throw new Error(`VERIFICATION_FAILED: canonical state was restored (${String(verificationError)})`);
    }
    if (transaction.verification.passed) {
      transaction.status = "VERIFIED";
    } else {
      await this.adapter.restore(before, attemptedAfter.revision);
      transaction.after = await this.project.inspectProject();
      this.assertRestored(before, transaction.after);
      transaction.status = "ROLLED_BACK";
    }
    this.transactions.set(transaction);
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

  public async undo(transactionId: string): Promise<ProjectSnapshot> {
    const transaction = this.getTransaction(transactionId);
    const current = await this.project.inspectProject();
    if (current.projectId !== transaction.before.projectId || current.timeline.id !== transaction.before.timeline.id) {
      throw new Error(
        `TARGET_MISMATCH: cannot undo ${transaction.before.projectId}/${transaction.before.timeline.id} while ${current.projectId}/${current.timeline.id} is active`,
      );
    }
    await this.adapter.restore(transaction.before, current.revision);
    const restored = await this.project.inspectProject();
    this.assertRestored(transaction.before, restored);
    return restored;
  }

  private assertRestored(expected: ProjectSnapshot, actual: ProjectSnapshot): void {
    if (canonicalSnapshotDigest(expected) !== canonicalSnapshotDigest(actual)) {
      throw new Error("ROLLBACK_FAILED: restored canonical digest does not match pre-edit state");
    }
  }

  private async assertCompositeCapabilities(operations: WorkflowOperation[]): Promise<void> {
    const capabilities = (await this.adapter.getCapabilities()).editor;
    if (!capabilities.compositeTransactions || !capabilities.readAfterWrite || !capabilities.rollback) {
      throw new Error("CAPABILITY_UNAVAILABLE: editor composite transactions");
    }
    if (operations.some((operation) => operation.type === "media.import") && !capabilities.mediaImport) {
      throw new Error("CAPABILITY_UNAVAILABLE: media import");
    }
    if (operations.some((operation) => operation.type === "timeline.media.add") && !capabilities.mediaPlacement) {
      throw new Error("CAPABILITY_UNAVAILABLE: timeline media placement");
    }
    if (operations.some((operation) => operation.type === "timeline.title.add")
      && (!capabilities.titlePlacement || !capabilities.assetDiscovery)) {
      throw new Error("CAPABILITY_UNAVAILABLE: timeline title placement");
    }
    if (operations.some((operation) => operation.type !== "media.import")
      && !capabilities.timelineWrite && !capabilities.timelineArtifactWrite) {
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
