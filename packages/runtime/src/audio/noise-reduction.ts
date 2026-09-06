import type { ContextRevision } from "../domain/primitives.js";
import type { EditOperation } from "../domain/editing.js";
import type { NoiseMeasurement } from "../domain/media.js";
import type { TimelineDiff } from "../domain/diff.js";

export type NoiseReductionDecision = "APPLY" | "NO_OP" | "SKIP";

export type NoiseReductionReasonCode =
  | "APPLY_NOISE_REDUCTION"
  | "ALREADY_BELOW_THRESHOLD"
  | "MEASUREMENT_INVALID"
  | "NO_AFFECTED_RANGE"
  | "CONFIDENCE_TOO_LOW"
  | "REDUCTION_INVALID";

export interface NoiseReductionPlanningOptions {
  noiseThresholdDb: number;
  maxReductionDb: number;
  minConfidence: number;
}

export interface NoiseReductionRequest extends NoiseReductionPlanningOptions {
  mediaId: string;
  occurrenceId: string;
  baseRevision: ContextRevision;
}

export interface NoiseReductionPlan extends NoiseReductionPlanningOptions {
  decision: NoiseReductionDecision;
  noiseFloorDb: number;
  recommendedReductionDb: number;
  reductionDb: number;
  affectedRanges: NoiseMeasurement["affectedRanges"];
  reasonCodes: NoiseReductionReasonCode[];
}

export interface NoiseReductionPreview {
  measurement: NoiseMeasurement;
  plan: NoiseReductionPlan;
  operations: EditOperation[];
  expectedDiff?: TimelineDiff;
  previewToken?: string;
  warnings: string[];
  expiresAt?: string;
}

export function planNoiseReduction(
  measurement: NoiseMeasurement,
  options: NoiseReductionPlanningOptions,
): NoiseReductionPlan {
  validateOptions(options);
  const recommendedReductionDb = finiteOrZero(measurement.recommendedReductionDb);
  const reductionDb = Math.min(Math.max(recommendedReductionDb, 0), options.maxReductionDb);
  const base = {
    ...structuredClone(options),
    noiseFloorDb: measurement.noiseFloorDb,
    recommendedReductionDb,
    reductionDb,
    affectedRanges: clampRanges(measurement.affectedRanges, measurement.requestedRange),
  };
  if (measurement.valid !== true || !Number.isFinite(measurement.noiseFloorDb)) {
    return { ...base, decision: "SKIP", reasonCodes: ["MEASUREMENT_INVALID"] };
  }
  if (measurement.noiseFloorDb <= options.noiseThresholdDb) {
    return { ...base, decision: "NO_OP", reductionDb: 0, reasonCodes: ["ALREADY_BELOW_THRESHOLD"] };
  }
  if (measurement.confidence < options.minConfidence) {
    return { ...base, decision: "SKIP", reasonCodes: ["CONFIDENCE_TOO_LOW"] };
  }
  if (base.affectedRanges.length === 0) {
    return { ...base, decision: "SKIP", reasonCodes: ["NO_AFFECTED_RANGE"] };
  }
  if (!Number.isFinite(recommendedReductionDb) || recommendedReductionDb <= 0 || reductionDb <= 0) {
    return { ...base, decision: "SKIP", reasonCodes: ["REDUCTION_INVALID"] };
  }
  return { ...base, decision: "APPLY", reasonCodes: ["APPLY_NOISE_REDUCTION"] };
}

function validateOptions(options: NoiseReductionPlanningOptions): void {
  if (!Number.isFinite(options.noiseThresholdDb)
    || !Number.isFinite(options.maxReductionDb) || options.maxReductionDb <= 0
    || !Number.isFinite(options.minConfidence) || options.minConfidence < 0 || options.minConfidence > 1) {
    throw new Error("INVALID_OPERATION: noise reduction policy is invalid");
  }
}

function clampRanges(
  ranges: NoiseMeasurement["affectedRanges"],
  bounds: { start: number; end: number },
): NoiseMeasurement["affectedRanges"] {
  return ranges
    .map((range) => ({
      start: Math.max(bounds.start, range.start),
      end: Math.min(bounds.end, range.end),
    }))
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start);
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
