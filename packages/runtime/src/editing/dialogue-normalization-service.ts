import type { AudioMeasurement } from "../domain/media.js";
import type {
  DialogueNormalizationPreview,
  DialogueNormalizationRequest,
} from "../audio/dialogue-normalization.js";
import { planDialogueGain } from "../audio/dialogue-normalization.js";
import type { EditTransaction } from "../domain/editing.js";
import type { VerificationCheck } from "../domain/verification.js";
import { sameRevision } from "../context/revision.js";
import { MediaAnalysisService } from "../application/media-analysis-service.js";
import { ProjectService } from "../application/project-service.js";
import { EditService } from "./edit-service.js";

interface StoredDialoguePreview {
  request: DialogueNormalizationRequest;
  measurement: AudioMeasurement;
}

export class DialogueNormalizationService {
  private readonly previews = new Map<string, StoredDialoguePreview>();

  public constructor(
    private readonly project: ProjectService,
    private readonly analysis: MediaAnalysisService,
    private readonly edits: EditService,
  ) {}

  public async preview(request: DialogueNormalizationRequest): Promise<DialogueNormalizationPreview> {
    const before = await this.project.inspectProject();
    if (!sameRevision(request.baseRevision, before.revision)) {
      throw new Error("STALE_CONTEXT: dialogue normalization base revision does not match current editor state");
    }
    const measurement = await this.analysis.measureAudio(request.mediaId, request.occurrenceId);
    const plan = planDialogueGain(measurement, request);
    const result: DialogueNormalizationPreview = {
      measurement,
      plan,
      operations: [],
      warnings: plan.decision === "SKIP" ? [...plan.reasonCodes] : [],
    };
    if (plan.decision !== "APPLY") return result;

    const operation: Extract<import("../domain/editing.js").EditOperation, { type: "set-gain" }> = {
      type: "set-gain",
      clipId: request.occurrenceId,
      gainDb: plan.clampedGainDb,
      baseRevision: request.baseRevision,
    };
    const editPreview = await this.edits.previewEdit({
      baseRevision: request.baseRevision,
      operations: [operation],
    });
    this.previews.set(editPreview.previewToken, { request: structuredClone(request), measurement });
    return {
      ...result,
      operations: [operation],
      expectedDiff: editPreview.expectedDiff,
      previewToken: editPreview.previewToken,
      warnings: editPreview.warnings,
      expiresAt: editPreview.expiresAt,
    };
  }

  public async execute(previewToken: string): Promise<EditTransaction> {
    const stored = this.previews.get(previewToken);
    if (!stored) throw new Error(`PREVIEW_TOKEN_INVALID: unknown dialogue normalization preview ${previewToken}`);
    this.previews.delete(previewToken);
    const transaction = await this.edits.executeEdit(previewToken);
    if (transaction.status !== "VERIFIED") return transaction;

    let afterMeasurement: AudioMeasurement;
    try {
      afterMeasurement = await this.analysis.measureAudio(stored.request.mediaId, stored.request.occurrenceId);
    } catch (error) {
      return this.rollbackAfterMeasurementFailure(transaction, error);
    }
    const checks = [
      measurementCheck(afterMeasurement),
      loudnessCheck(afterMeasurement, stored.request),
      peakCheck(afterMeasurement, stored.request),
    ];
    const verification = transaction.verification ?? { passed: true, checks: [] };
    transaction.verification = {
      ...verification,
      checks: [...verification.checks, ...checks],
      passed: verification.passed && checks.every((check) => check.passed),
    };
    if (transaction.verification.passed) return transaction;

    const restored = await this.edits.undo(transaction.id);
    transaction.after = restored;
    transaction.status = "ROLLED_BACK";
    return transaction;
  }

  private async rollbackAfterMeasurementFailure(transaction: EditTransaction, error: unknown): Promise<EditTransaction> {
    const restored = await this.edits.undo(transaction.id);
    transaction.after = restored;
    transaction.status = "ROLLED_BACK";
    const check: VerificationCheck = {
      name: "dialogue-measurement",
      passed: false,
      status: "failed",
      reason: "POST_WRITE_MEASUREMENT_FAILED",
      detail: String(error),
    };
    transaction.verification = {
      ...(transaction.verification ?? { passed: true, checks: [] }),
      passed: false,
      checks: [...(transaction.verification?.checks ?? []), check],
    };
    return transaction;
  }
}

function measurementCheck(measurement: AudioMeasurement): VerificationCheck {
  return {
    name: "dialogue-measurement",
    passed: measurement.valid,
    status: measurement.valid ? "passed" : "failed",
    observed: measurement,
    reason: measurement.valid ? undefined : "MEASUREMENT_INVALID",
    detail: measurement.valid ? "post-write dialogue measurement is valid" : "post-write dialogue measurement is invalid",
  };
}

function loudnessCheck(
  measurement: AudioMeasurement,
  request: DialogueNormalizationRequest,
): VerificationCheck {
  const passed = measurement.valid && Math.abs(measurement.integratedLufs - request.targetLufs) <= request.toleranceDb;
  return {
    name: "dialogue-loudness",
    passed,
    status: passed ? "passed" : "failed",
    expected: { targetLufs: request.targetLufs, toleranceDb: request.toleranceDb },
    observed: { integratedLufs: measurement.integratedLufs },
    detail: passed ? "post-write loudness is inside the configured tolerance" : "post-write loudness is outside the configured tolerance",
  };
}

function peakCheck(
  measurement: AudioMeasurement,
  request: DialogueNormalizationRequest,
): VerificationCheck {
  const passed = measurement.valid && measurement.truePeakDb <= request.maxTruePeakDb;
  return {
    name: "dialogue-true-peak",
    passed,
    status: passed ? "passed" : "failed",
    expected: { maxTruePeakDb: request.maxTruePeakDb },
    observed: { truePeakDb: measurement.truePeakDb },
    detail: passed ? "post-write true peak is within the configured limit" : "post-write true peak exceeds the configured limit",
  };
}
