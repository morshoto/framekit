import { SPEECH_ANALYSIS_SCHEMA_VERSION } from "../domain/media.js";
import type {
  AnalysisInput,
  AnalyzerDescriptor,
  MediaSourceIdentity,
  RevisionBoundSpeechAnalysis,
  SpeechAnalysis,
  SpeechAnalysisCapability,
  SpeechSegment,
  SpeechWord,
} from "../domain/media.js";
import { sameMediaSourceIdentity } from "../domain/media.js";
import type { RationalTime, TimeRange } from "../domain/primitives.js";
import { parseRational } from "../timeline/rational-time.js";

export const DEFAULT_SPEECH_SOURCE_TIMEBASE: RationalTime = {
  value: "1",
  timescale: "1000",
};

export interface SpeechBindingContext {
  input: AnalysisInput;
  provider?: AnalyzerDescriptor;
  range?: TimeRange;
}

/**
 * Validate provider evidence and bind it to the current source and revision.
 * Missing provenance is filled from the trusted runtime request; conflicting
 * provenance is rejected before the evidence can authorize an edit.
 */
export function bindSpeechAnalysis(
  value: unknown,
  context: SpeechBindingContext,
): RevisionBoundSpeechAnalysis {
  const record = asRecord(value, "speech result must be an object");
  if (record.schemaVersion !== undefined && record.schemaVersion !== SPEECH_ANALYSIS_SCHEMA_VERSION) {
    throw new Error("ANALYSIS_INVALID: unsupported speech analysis schema version");
  }
  const inputIdentity = sourceIdentityOf(context.input.media);
  const mediaId = optionalString(record.mediaId, "speech media ID");
  if (mediaId !== undefined && mediaId !== inputIdentity.mediaId) {
    throw new Error("TARGET_MISMATCH: speech analysis media identity does not match the requested media");
  }

  const sourceIdentity = record.sourceIdentity === undefined
    ? inputIdentity
    : validateSourceIdentity(record.sourceIdentity, inputIdentity);
  const revision = record.revision === undefined
    ? structuredClone(context.input.project.revision)
    : validateRevision(record.revision, context.input.project.revision);
  const provider = record.provider === undefined
    ? context.provider ?? { id: "framekit.speech", provider: "unknown" }
    : validateDescriptor(record.provider);
  const requestedRange = resolveRequestedRange(record.requestedRange, context.range, context.input.media, record);
  const observedRange = record.observedRange === undefined
    ? structuredClone(requestedRange)
    : validateRange(record.observedRange, "observed speech range");
  validateRange(requestedRange, "requested speech range");
  validateObservedRange(observedRange, requestedRange, context.input.media.duration);

  const words = validateWords(record.words, observedRange, context.input.media.duration);
  const vadSegments = validateOptionalSegments(record.vadSegments, "VAD", observedRange, context.input.media.duration);
  const silenceSegments = validateOptionalSegments(record.silenceSegments, "silence", observedRange, context.input.media.duration);
  const protectedSegments = validateOptionalSegments(record.protectedSegments, "protected", observedRange, context.input.media.duration);
  const capability = validateCapability(record.capability, vadSegments);
  const sourceTimebase = record.sourceTimebase === undefined
    ? structuredClone(DEFAULT_SPEECH_SOURCE_TIMEBASE)
    : validateSourceTimebase(record.sourceTimebase);

  return {
    schemaVersion: SPEECH_ANALYSIS_SCHEMA_VERSION,
    mediaId: inputIdentity.mediaId,
    sourceIdentity: structuredClone(sourceIdentity),
    requestedRange: structuredClone(requestedRange),
    observedRange: structuredClone(observedRange),
    revision: structuredClone(revision),
    provider: structuredClone(provider),
    sourceTimebase,
    capability,
    words,
    ...(vadSegments ? { vadSegments } : {}),
    ...(silenceSegments ? { silenceSegments } : {}),
    ...(protectedSegments ? { protectedSegments } : {}),
  };
}

function sourceIdentityOf(media: AnalysisInput["media"]): MediaSourceIdentity {
  return {
    mediaId: media.mediaId,
    source: media.source,
    ...(media.sourceDigest ? { sourceDigest: media.sourceDigest } : {}),
    ...(media.mediaKind ? { mediaKind: media.mediaKind } : {}),
    ...(media.duration !== undefined ? { duration: media.duration } : {}),
  };
}

function resolveRequestedRange(
  result: unknown,
  requested: TimeRange | undefined,
  media: AnalysisInput["media"],
  record: Record<string, unknown>,
): TimeRange {
  if (result !== undefined) {
    const resultRange = validateRange(result, "requested speech range");
    if (requested && (resultRange.start !== requested.start || resultRange.end !== requested.end)) {
      throw new Error("ANALYSIS_INVALID: speech requested range does not match the runtime request");
    }
    return resultRange;
  }
  if (requested) return structuredClone(requested);
  if (media.duration !== undefined) return { start: 0, end: media.duration };
  const evidenceEnd = evidenceMaximumEnd(record);
  if (evidenceEnd <= 0) throw new Error("ANALYSIS_INVALID: speech result needs a range or media duration");
  return { start: 0, end: evidenceEnd };
}

function evidenceMaximumEnd(record: Record<string, unknown>): number {
  const values: number[] = [];
  for (const key of ["words", "vadSegments", "silenceSegments", "protectedSegments"] as const) {
    const entries = record[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).end === "number") {
        values.push((entry as Record<string, unknown>).end as number);
      }
    }
  }
  return values.length > 0 ? Math.max(...values) : 0;
}

function validateObservedRange(observed: TimeRange, requested: TimeRange, duration: number | undefined): void {
  if (observed.end <= requested.start || observed.start >= requested.end) {
    throw new Error("ANALYSIS_INVALID: observed speech range does not overlap the requested range");
  }
  if (duration !== undefined && observed.end > duration) {
    throw new Error("ANALYSIS_INVALID: observed speech range exceeds media duration");
  }
}

function validateWords(value: unknown, observed: TimeRange, duration: number | undefined): SpeechWord[] {
  if (!Array.isArray(value)) throw new Error("ANALYSIS_INVALID: speech result requires typed words");
  const words = value.map((entry, index) => validateWord(entry, index));
  validateOrderedRanges(words, "speech words");
  validateEvidenceBounds(words, observed, duration, "speech word");
  return words;
}

function validateWord(value: unknown, index: number): SpeechWord {
  const word = asRecord(value, `speech word ${index + 1} must be an object`);
  if (typeof word.text !== "string" || !word.text.trim()) {
    throw new Error("ANALYSIS_INVALID: speech word text is required");
  }
  if (!isFiniteNumber(word.start) || !isFiniteNumber(word.end) || word.start < 0 || word.end <= word.start) {
    throw new Error("ANALYSIS_INVALID: speech word boundaries are invalid");
  }
  if (!isFiniteNumber(word.confidence) || word.confidence < 0 || word.confidence > 1) {
    throw new Error("ANALYSIS_INVALID: speech word confidence is invalid");
  }
  if (word.filler !== undefined && typeof word.filler !== "boolean") {
    throw new Error("ANALYSIS_INVALID: speech word filler flag is invalid");
  }
  return {
    text: word.text,
    start: word.start,
    end: word.end,
    confidence: word.confidence,
    ...(word.filler !== undefined ? { filler: word.filler } : {}),
  };
}

function validateOptionalSegments(
  value: unknown,
  label: string,
  observed: TimeRange,
  duration: number | undefined,
): SpeechSegment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`ANALYSIS_INVALID: ${label} segments must be an array`);
  const segments = value.map((entry, index) => validateSegment(entry, index, label));
  validateOrderedRanges(segments, `${label} segments`);
  validateEvidenceBounds(segments, observed, duration, `${label} segment`);
  return segments;
}

function validateSegment(value: unknown, index: number, label: string): SpeechSegment {
  const segment = asRecord(value, `${label} segment ${index + 1} must be an object`);
  if (!isFiniteNumber(segment.start) || !isFiniteNumber(segment.end)
    || segment.start < 0 || segment.end <= segment.start) {
    throw new Error(`ANALYSIS_INVALID: ${label} segment boundaries are invalid`);
  }
  if (!["speech", "silence", "breath", "laughter", "noise"].includes(String(segment.kind))) {
    throw new Error(`ANALYSIS_INVALID: ${label} segment kind is invalid`);
  }
  if (segment.confidence !== undefined
    && (!isFiniteNumber(segment.confidence) || segment.confidence < 0 || segment.confidence > 1)) {
    throw new Error(`ANALYSIS_INVALID: ${label} segment confidence is invalid`);
  }
  return {
    start: segment.start,
    end: segment.end,
    kind: segment.kind as SpeechSegment["kind"],
    ...(segment.confidence !== undefined ? { confidence: segment.confidence } : {}),
  };
}

function validateEvidenceBounds(
  evidence: Array<{ start: number; end: number }>,
  observed: TimeRange,
  duration: number | undefined,
  label: string,
): void {
  for (const entry of evidence) {
    if (entry.start < observed.start || entry.end > observed.end) {
      throw new Error(`ANALYSIS_INVALID: ${label} is outside observed speech range`);
    }
    if (duration !== undefined && entry.end > duration) {
      throw new Error(`ANALYSIS_INVALID: ${label} exceeds media duration`);
    }
  }
}

function validateOrderedRanges(evidence: Array<{ start: number; end: number }>, label: string): void {
  for (let index = 1; index < evidence.length; index += 1) {
    const previous = evidence[index - 1]!;
    const current = evidence[index]!;
    if (current.start < previous.start || (current.start === previous.start && current.end < previous.end)) {
      throw new Error(`ANALYSIS_INVALID: ${label} must be ordered`);
    }
    if (current.start < previous.end) {
      throw new Error(`ANALYSIS_INVALID: ${label} overlap`);
    }
  }
}

function validateCapability(value: unknown, vadSegments: SpeechSegment[] | undefined): SpeechAnalysisCapability {
  const capability = value ?? (vadSegments ? "transcription-plus-vad" : "transcription-only");
  if (capability !== "transcription-only" && capability !== "transcription-plus-vad") {
    throw new Error("ANALYSIS_INVALID: speech capability is unsupported");
  }
  if (capability === "transcription-plus-vad" && !vadSegments) {
    throw new Error("ANALYSIS_INVALID: transcription-plus-vad requires VAD segments");
  }
  if (capability === "transcription-only" && vadSegments) {
    throw new Error("ANALYSIS_INVALID: VAD evidence requires transcription-plus-vad capability");
  }
  return capability;
}

function validateSourceIdentity(value: unknown, expected: MediaSourceIdentity): MediaSourceIdentity {
  const identity = asRecord(value, "speech source identity must be an object");
  if (typeof identity.mediaId !== "string" || typeof identity.source !== "string") {
    throw new Error("ANALYSIS_INVALID: speech source identity is incomplete");
  }
  const candidate: MediaSourceIdentity = {
    mediaId: identity.mediaId,
    source: identity.source,
    ...(identity.sourceDigest !== undefined
      ? { sourceDigest: optionalString(identity.sourceDigest, "speech source digest") }
      : expected.sourceDigest !== undefined ? { sourceDigest: expected.sourceDigest } : {}),
    ...(identity.mediaKind !== undefined
      ? { mediaKind: identity.mediaKind as MediaSourceIdentity["mediaKind"] }
      : expected.mediaKind !== undefined ? { mediaKind: expected.mediaKind } : {}),
    ...(identity.duration !== undefined
      ? { duration: numberValue(identity.duration, "speech source duration") }
      : expected.duration !== undefined ? { duration: expected.duration } : {}),
  };
  if (!sameMediaSourceIdentity(candidate, expected)) {
    throw new Error("TARGET_MISMATCH: speech analysis source identity does not match the requested media");
  }
  return candidate;
}

function validateRevision(value: unknown, expected: AnalysisInput["project"]["revision"]): AnalysisInput["project"]["revision"] {
  const revision = asRecord(value, "speech revision must be an object");
  if (typeof revision.id !== "string" || !Number.isInteger(revision.sequence) || typeof revision.timestamp !== "string") {
    throw new Error("ANALYSIS_INVALID: speech revision is incomplete");
  }
  if (revision.id !== expected.id || revision.sequence !== expected.sequence || revision.timestamp !== expected.timestamp) {
    throw new Error("STALE_CONTEXT: speech analysis revision does not match the current editor state");
  }
  return { id: revision.id, sequence: revision.sequence, timestamp: revision.timestamp };
}

function validateDescriptor(value: unknown): AnalyzerDescriptor {
  const descriptor = asRecord(value, "speech provider must be an object");
  if (typeof descriptor.id !== "string" || !descriptor.id.trim() || typeof descriptor.provider !== "string" || !descriptor.provider.trim()) {
    throw new Error("ANALYSIS_INVALID: speech provider descriptor is incomplete");
  }
  if (descriptor.version !== undefined && typeof descriptor.version !== "string") {
    throw new Error("ANALYSIS_INVALID: speech provider version is invalid");
  }
  return {
    id: descriptor.id,
    provider: descriptor.provider,
    ...(descriptor.version !== undefined ? { version: descriptor.version } : {}),
  };
}

function validateSourceTimebase(value: unknown): RationalTime {
  const timebase = asRecord(value, "speech source timebase must be an object") as Partial<RationalTime>;
  if (typeof timebase.value !== "string" || typeof timebase.timescale !== "string") {
    throw new Error("ANALYSIS_INVALID: speech source timebase is incomplete");
  }
  const parsed = parseRational({ value: timebase.value, timescale: timebase.timescale }, "ANALYSIS_INVALID");
  if (parsed.value <= 0n) throw new Error("ANALYSIS_INVALID: speech source timebase must be positive");
  return { value: timebase.value, timescale: timebase.timescale };
}

function validateRange(value: unknown, label: string): TimeRange {
  const range = asRecord(value, `${label} must be an object`);
  if (!isFiniteNumber(range.start) || !isFiniteNumber(range.end) || range.start < 0 || range.end <= range.start) {
    throw new Error(`ANALYSIS_INVALID: ${label} is invalid`);
  }
  return {
    start: range.start,
    end: range.end,
    ...(range.startTime !== undefined ? { startTime: validateRational(range.startTime, `${label} start time`) } : {}),
    ...(range.durationTime !== undefined ? { durationTime: validateRational(range.durationTime, `${label} duration time`) } : {}),
  };
}

function validateRational(value: unknown, label: string): RationalTime {
  const rational = asRecord(value, `${label} must be an object`);
  if (typeof rational.value !== "string" || typeof rational.timescale !== "string") {
    throw new Error(`ANALYSIS_INVALID: ${label} is incomplete`);
  }
  parseRational({ value: rational.value, timescale: rational.timescale }, "ANALYSIS_INVALID");
  return { value: rational.value, timescale: rational.timescale };
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`ANALYSIS_INVALID: ${label} is invalid`);
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (!isFiniteNumber(value)) throw new Error(`ANALYSIS_INVALID: ${label} is invalid`);
  return value;
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`ANALYSIS_INVALID: ${message}`);
  return value as Record<string, unknown>;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
