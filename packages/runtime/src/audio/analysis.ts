import type { RationalTime } from "../domain/primitives.js";
import { parseRational } from "../timeline/rational-time.js";

/** Validate the measurement payload before binding provenance or serializing it. */
export function validateAudioAnalysisPayload(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ANALYSIS_INVALID: audio analysis must be an object");
  }
  const analysis = value as Record<string, unknown>;
  for (const field of ["integratedLufs", "truePeakDb", "silenceMs"]) {
    const measured = analysis[field];
    if (typeof measured !== "number" || !Number.isFinite(measured)) {
      throw new Error(`ANALYSIS_INVALID: audio ${field} must be finite`);
    }
  }
  if ((analysis.silenceMs as number) < 0) {
    throw new Error("ANALYSIS_INVALID: audio silenceMs must be nonnegative");
  }
  if (analysis.analyzedDurationSeconds !== undefined
    && (typeof analysis.analyzedDurationSeconds !== "number"
      || !Number.isFinite(analysis.analyzedDurationSeconds) || analysis.analyzedDurationSeconds <= 0)) {
    throw new Error("ANALYSIS_INVALID: audio analyzedDurationSeconds must be finite and positive");
  }
  if (analysis.audibleSamples !== undefined
    && (typeof analysis.audibleSamples !== "number" || !Number.isSafeInteger(analysis.audibleSamples)
      || analysis.audibleSamples < 0)) {
    throw new Error("ANALYSIS_INVALID: audio audibleSamples must be a nonnegative safe integer");
  }
  for (const field of ["dialoguePresent", "valid"]) {
    if (analysis[field] !== undefined && typeof analysis[field] !== "boolean") {
      throw new Error(`ANALYSIS_INVALID: audio ${field} must be boolean`);
    }
  }
  if (analysis.invalidReason !== undefined && typeof analysis.invalidReason !== "string") {
    throw new Error("ANALYSIS_INVALID: audio invalidReason must be text");
  }
  if (analysis.sourceTimebase !== undefined) rationalSeconds(analysis.sourceTimebase, "sourceTimebase");
  for (const field of ["requestedRange", "measuredRange"]) {
    if (analysis[field] !== undefined) validateRange(analysis[field], field);
  }
  if (analysis.signalFormat !== undefined) {
    const format = analysis.signalFormat;
    if (!format || typeof format !== "object" || Array.isArray(format)) {
      throw new Error("ANALYSIS_INVALID: audio signalFormat must be an object");
    }
    for (const field of ["sampleRate", "channels"]) {
      const count = (format as Record<string, unknown>)[field];
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0) {
        throw new Error(`ANALYSIS_INVALID: audio signalFormat ${field} must be a positive safe integer`);
      }
    }
    const layout = (format as Record<string, unknown>).channelLayout;
    if (layout !== undefined && (typeof layout !== "string" || !layout.trim())) {
      throw new Error("ANALYSIS_INVALID: audio channelLayout must be nonempty text");
    }
  }
}

function rationalSeconds(value: unknown, label: string, allowZero = false): number {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof (value as RationalTime).value !== "string"
    || typeof (value as RationalTime).timescale !== "string") {
    throw new Error(`ANALYSIS_INVALID: audio ${label} must be a rational time`);
  }
  const parsed = parseRational(value as RationalTime, "ANALYSIS_INVALID");
  const seconds = Number(parsed.value) / Number(parsed.timescale);
  if (!Number.isFinite(seconds) || (allowZero ? seconds < 0 : seconds <= 0)) {
    throw new Error(`ANALYSIS_INVALID: audio ${label} must be ${allowZero ? "nonnegative" : "positive"}`);
  }
  return seconds;
}

function validateRange(value: unknown, label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`ANALYSIS_INVALID: audio ${label} must be a range`);
  }
  const range = value as Record<string, unknown>;
  if (typeof range.start !== "number" || typeof range.end !== "number"
    || !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end <= range.start) {
    throw new Error(`ANALYSIS_INVALID: audio ${label} must be finite and positive`);
  }
  if (range.startTime !== undefined
    && Math.abs(rationalSeconds(range.startTime, label + " start", true) - range.start) > 0.000000001) {
    throw new Error(`ANALYSIS_INVALID: audio ${label} numeric and rational start differ`);
  }
  if (range.durationTime !== undefined
    && Math.abs(rationalSeconds(range.durationTime, label + " duration") - (range.end - range.start)) > 0.000000001) {
    throw new Error(`ANALYSIS_INVALID: audio ${label} numeric and rational duration differ`);
  }
}
