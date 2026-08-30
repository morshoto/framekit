import type { AudioMeasurement } from "../domain/media.js";

export type DialogueGainDecision = "APPLY" | "NO_OP" | "SKIP";

export type DialogueGainReasonCode =
  | "APPLY_GAIN"
  | "ALREADY_IN_TOLERANCE"
  | "MEASUREMENT_INVALID"
  | "NO_DIALOGUE"
  | "SILENCE"
  | "DIALOGUE_TOO_SHORT"
  | "GAIN_OUT_OF_BOUNDS"
  | "PEAK_RISK";

export interface DialogueGainPlanningOptions {
  targetLufs: number;
  toleranceDb: number;
  maxTruePeakDb: number;
  minGainDb: number;
  maxGainDb: number;
  minDialogueDurationSeconds: number;
}

export interface DialogueGainPlan extends DialogueGainPlanningOptions {
  decision: DialogueGainDecision;
  currentLufs: number;
  desiredGainDb: number;
  clampedGainDb: number;
  estimatedPeakDb: number;
  reasonCodes: DialogueGainReasonCode[];
}

/** Plan a bounded clip-level gain change without mutating an editor. */
export function planDialogueGain(
  measurement: AudioMeasurement,
  options: DialogueGainPlanningOptions,
): DialogueGainPlan {
  validateOptions(options);
  const currentLufs = finiteOrZero(measurement.integratedLufs);
  const desiredGainDb = roundDb(options.targetLufs - currentLufs);
  const clampedGainDb = clamp(desiredGainDb, options.minGainDb, options.maxGainDb);
  const estimatedPeakDb = roundDb(finiteOrZero(measurement.truePeakDb) + clampedGainDb);
  const base = {
    ...structuredClone(options),
    currentLufs,
    desiredGainDb,
    clampedGainDb,
    estimatedPeakDb,
  };

  if (!measurement.valid || !Number.isFinite(measurement.integratedLufs)
    || !Number.isFinite(measurement.truePeakDb) || !Number.isFinite(measurement.silenceMs)
    || !Number.isFinite(measurement.analyzedDurationSeconds)) {
    return { ...base, decision: "SKIP", reasonCodes: ["MEASUREMENT_INVALID"] };
  }
  if (!measurement.dialoguePresent) {
    return { ...base, decision: "SKIP", reasonCodes: ["NO_DIALOGUE"] };
  }
  if (measurement.silenceMs >= measurement.analyzedDurationSeconds * 1000) {
    return { ...base, decision: "SKIP", reasonCodes: ["SILENCE"] };
  }
  if (measurement.analyzedDurationSeconds < options.minDialogueDurationSeconds) {
    return { ...base, decision: "SKIP", reasonCodes: ["DIALOGUE_TOO_SHORT"] };
  }
  if (Math.abs(measurement.integratedLufs - options.targetLufs) <= options.toleranceDb) {
    return {
      ...base,
      decision: "NO_OP",
      desiredGainDb: 0,
      clampedGainDb: 0,
      estimatedPeakDb: measurement.truePeakDb,
      reasonCodes: ["ALREADY_IN_TOLERANCE"],
    };
  }
  if (desiredGainDb < options.minGainDb || desiredGainDb > options.maxGainDb) {
    return { ...base, decision: "SKIP", reasonCodes: ["GAIN_OUT_OF_BOUNDS"] };
  }
  if (estimatedPeakDb > options.maxTruePeakDb) {
    return { ...base, decision: "SKIP", reasonCodes: ["PEAK_RISK"] };
  }
  return { ...base, decision: "APPLY", reasonCodes: ["APPLY_GAIN"] };
}

function validateOptions(options: DialogueGainPlanningOptions): void {
  if (!Number.isFinite(options.targetLufs) || !Number.isFinite(options.toleranceDb) || options.toleranceDb < 0
    || !Number.isFinite(options.maxTruePeakDb)
    || !Number.isFinite(options.minGainDb) || !Number.isFinite(options.maxGainDb)
    || options.minGainDb > options.maxGainDb
    || !Number.isFinite(options.minDialogueDurationSeconds) || options.minDialogueDurationSeconds < 0) {
    throw new Error("INVALID_OPERATION: dialogue gain policy is invalid");
  }
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function roundDb(value: number): number {
  return Number(value.toFixed(6));
}
