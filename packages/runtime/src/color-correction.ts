import type { ContextRevision } from "./domain/primitives.js";
import type { EditOperation } from "./domain/editing.js";
import type { Clip, ColorCorrection, ColorCorrectionPreset } from "./domain/project.js";
import type { TimelineDiff } from "./domain/diff.js";

export interface ColorCorrectionRequest {
  clipId: string;
  baseRevision: ContextRevision;
  preset?: ColorCorrectionPreset;
  exposure?: number;
  contrast?: number;
  saturation?: number;
  temperature?: number;
  tint?: number;
}

export interface ColorCorrectionPlan {
  decision: "APPLY" | "NO_OP";
  clipId: string;
  before: ColorCorrection;
  after: ColorCorrection;
  changedFields: Array<keyof ColorCorrection>;
  reasonCodes: Array<"APPLY_COLOR_CORRECTION" | "ALREADY_MATCHES">;
}

export interface ColorCorrectionPreview {
  plan: ColorCorrectionPlan;
  operation?: EditOperation;
  expectedDiff?: TimelineDiff;
  previewToken?: string;
  warnings: string[];
  expiresAt?: string;
}

export const COLOR_CORRECTION_PRESETS: Record<ColorCorrectionPreset, ColorCorrection> = {
  neutral: { exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, preset: "neutral" },
  warm: { exposure: 0.1, contrast: 0, saturation: 0.1, temperature: 15, tint: 0, preset: "warm" },
  cool: { exposure: 0.1, contrast: 0, saturation: 0, temperature: -15, tint: 0, preset: "cool" },
  "high-contrast": { exposure: 0, contrast: 0.25, saturation: 0.05, temperature: 0, tint: 0, preset: "high-contrast" },
};

export function planColorCorrection(clip: Clip, request: ColorCorrectionRequest): ColorCorrectionPlan {
  const before = normalizeCorrection(clip.colorCorrection);
  const preset = request.preset ? COLOR_CORRECTION_PRESETS[request.preset] : before;
  const after: ColorCorrection = {
    exposure: request.exposure ?? preset.exposure,
    contrast: request.contrast ?? preset.contrast,
    saturation: request.saturation ?? preset.saturation,
    temperature: request.temperature ?? preset.temperature,
    tint: request.tint ?? preset.tint,
    ...(request.preset ? { preset: request.preset } : clip.colorCorrection?.preset ? { preset: clip.colorCorrection.preset } : {}),
  };
  validateCorrection(after);
  const changedFields = (Object.keys(after) as Array<keyof ColorCorrection>)
    .filter((field) => after[field] !== before[field]);
  return {
    decision: changedFields.length > 0 ? "APPLY" : "NO_OP",
    clipId: clip.id,
    before,
    after,
    changedFields,
    reasonCodes: changedFields.length > 0 ? ["APPLY_COLOR_CORRECTION"] : ["ALREADY_MATCHES"],
  };
}

export function normalizeCorrection(correction?: ColorCorrection): ColorCorrection {
  return {
    exposure: correction?.exposure ?? 0,
    contrast: correction?.contrast ?? 0,
    saturation: correction?.saturation ?? 0,
    temperature: correction?.temperature ?? 0,
    tint: correction?.tint ?? 0,
    ...(correction?.preset ? { preset: correction.preset } : {}),
  };
}

function validateCorrection(correction: ColorCorrection): void {
  if (!Number.isFinite(correction.exposure) || correction.exposure < -4 || correction.exposure > 4
    || !Number.isFinite(correction.contrast) || correction.contrast < -1 || correction.contrast > 1
    || !Number.isFinite(correction.saturation) || correction.saturation < -1 || correction.saturation > 1
    || !Number.isFinite(correction.temperature) || correction.temperature < -100 || correction.temperature > 100
    || !Number.isFinite(correction.tint) || correction.tint < -100 || correction.tint > 100) {
    throw new Error("INVALID_OPERATION: color correction values are outside the supported basic range");
  }
}
