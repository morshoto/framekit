import type {
  RevisionBoundSpeechAnalysis,
  SpeechSegment,
  SpeechWord,
} from "../domain/media.js";
import type { ContextRevision, RationalTime, TimeRange } from "../domain/primitives.js";
import { addRationalTimes, parseRational, subtractRationalTimes } from "../timeline/rational-time.js";

export interface SpeechOccurrence {
  occurrenceId: string;
  mediaId: string;
  revision: ContextRevision;
  sourceRange: TimeRange;
  sequenceRange: TimeRange;
  /** Expected source clock for this occurrence when the editor exposes one. */
  sourceTimebase?: RationalTime;
}

export interface SpeechMappingOptions {
  sequenceFrameDuration: RationalTime;
}

export interface MappedSpeechWord {
  word: SpeechWord;
  sourceRange: TimeRange;
  sequenceRange: TimeRange;
  frameAlignedRange: TimeRange;
}

export interface MappedSpeechSegment {
  segment: SpeechSegment;
  sourceRange: TimeRange;
  sequenceRange: TimeRange;
  frameAlignedRange: TimeRange;
}

export interface SpeechOccurrenceMapping {
  occurrenceId: string;
  mediaId: string;
  revision: ContextRevision;
  sourceRange: TimeRange;
  sequenceRange: TimeRange;
  sourceTimebase: RationalTime;
  sequenceFrameDuration: RationalTime;
  capability: RevisionBoundSpeechAnalysis["capability"];
  words: MappedSpeechWord[];
  vadSegments?: MappedSpeechSegment[];
  silenceSegments?: MappedSpeechSegment[];
  protectedSegments?: MappedSpeechSegment[];
}

/** Map validated source evidence onto one exact timeline occurrence. */
export function mapSpeechAnalysisToOccurrence(
  analysis: RevisionBoundSpeechAnalysis,
  occurrence: SpeechOccurrence,
  options: SpeechMappingOptions,
): SpeechOccurrenceMapping {
  validateOccurrence(occurrence);
  if (analysis.mediaId !== occurrence.mediaId) {
    throw new Error("TARGET_MISMATCH: speech analysis media does not match the timeline occurrence");
  }
  if (!sameRevision(analysis.revision, occurrence.revision)) {
    throw new Error("STALE_CONTEXT: speech analysis revision does not match the timeline occurrence");
  }
  if (!analysis.sourceTimebase) {
    throw new Error("ANALYSIS_INVALID: speech source timebase is required for mapping");
  }
  const sourceTimebase = validatePositiveRational(analysis.sourceTimebase, "ANALYSIS_INVALID", "speech source timebase");
  if (occurrence.sourceTimebase !== undefined) {
    const occurrenceTimebase = validatePositiveRational(occurrence.sourceTimebase, "ANALYSIS_INVALID", "occurrence source timebase");
    if (!sameRational(sourceTimebase, occurrenceTimebase)) {
      throw new Error("AMBIGUOUS_MAPPING: speech source timebase does not match the timeline occurrence");
    }
  }
  const frame = validatePositiveRational(options.sequenceFrameDuration, "ANALYSIS_INVALID", "sequence frame duration");
  const sourceDuration = occurrence.sourceRange.end - occurrence.sourceRange.start;
  const sequenceDuration = occurrence.sequenceRange.end - occurrence.sequenceRange.start;
  if (Math.abs(sourceDuration - sequenceDuration) > 0.000000001) {
    throw new Error("AMBIGUOUS_MAPPING: source and sequence occurrence durations differ");
  }
  validateSequenceRationalRange(occurrence.sequenceRange);

  return {
    occurrenceId: occurrence.occurrenceId,
    mediaId: occurrence.mediaId,
    revision: structuredClone(occurrence.revision),
    sourceRange: structuredClone(occurrence.sourceRange),
    sequenceRange: structuredClone(occurrence.sequenceRange),
    sourceTimebase,
    sequenceFrameDuration: frame,
    capability: analysis.capability,
    words: mapEvidence(analysis.words, occurrence, frame, "speech word", (word) => word),
    ...(analysis.vadSegments
      ? { vadSegments: mapEvidence(analysis.vadSegments, occurrence, frame, "VAD segment", (segment) => segment) }
      : {}),
    ...(analysis.silenceSegments
      ? { silenceSegments: mapEvidence(analysis.silenceSegments, occurrence, frame, "silence segment", (segment) => segment) }
      : {}),
    ...(analysis.protectedSegments
      ? { protectedSegments: mapEvidence(analysis.protectedSegments, occurrence, frame, "protected segment", (segment) => segment) }
      : {}),
  };
}

/** Map one source range onto an exact timeline occurrence. */
export function mapSourceRangeToSequenceRange(
  sourceRange: TimeRange,
  occurrence: Pick<SpeechOccurrence, "sourceRange" | "sequenceRange">,
): TimeRange {
  validateRange(sourceRange, "source range");
  validateRange(occurrence.sourceRange, "source occurrence range");
  validateRange(occurrence.sequenceRange, "sequence occurrence range");
  const sourceDuration = occurrence.sourceRange.end - occurrence.sourceRange.start;
  const sequenceDuration = occurrence.sequenceRange.end - occurrence.sequenceRange.start;
  if (Math.abs(sourceDuration - sequenceDuration) > 0.000000001) {
    throw new Error("AMBIGUOUS_MAPPING: source and sequence occurrence durations differ");
  }
  const relation = relationToRange(sourceRange, occurrence.sourceRange);
  if (relation === "outside") throw new Error("AMBIGUOUS_MAPPING: source range is outside the occurrence");
  if (relation === "partial") throw new Error("AMBIGUOUS_MAPPING: source range crosses the occurrence boundary");
  return translateRange(sourceRange, occurrence, validateSequenceRationalRange(occurrence.sequenceRange));
}

function mapEvidence<T extends { start: number; end: number }, M>(
  evidence: T[],
  occurrence: SpeechOccurrence,
  frame: RationalTime,
  label: string,
  clone: (value: T) => M,
): Array<M extends SpeechWord ? MappedSpeechWord : MappedSpeechSegment> {
  const mapped: Array<M extends SpeechWord ? MappedSpeechWord : MappedSpeechSegment> = [];
  for (const value of evidence) {
    const relation = relationToRange(value, occurrence.sourceRange);
    if (relation === "outside") continue;
    if (relation === "partial") {
      throw new Error(`AMBIGUOUS_MAPPING: ${label} crosses the occurrence source boundary`);
    }
    const sourceRange = { start: value.start, end: value.end };
    const sequenceRange = mapSourceRangeToSequenceRange(sourceRange, occurrence);
    const frameAlignedRange = alignRange(sequenceRange, frame);
    if (!containsRange(occurrence.sequenceRange, frameAlignedRange)) {
      throw new Error(`AMBIGUOUS_MAPPING: ${label} cannot be frame-aligned inside the occurrence`);
    }
    const mappedValue = {
      ...("text" in value ? { word: clone(value as T) as SpeechWord } : { segment: clone(value as T) as SpeechSegment }),
      sourceRange,
      sequenceRange,
      frameAlignedRange,
    } as M extends SpeechWord ? MappedSpeechWord : MappedSpeechSegment;
    mapped.push(mappedValue);
  }
  return mapped;
}

function translateRange(
  source: TimeRange,
  occurrence: Pick<SpeechOccurrence, "sourceRange" | "sequenceRange">,
  sequenceStartTime: RationalTime,
): TimeRange {
  const offset = source.start - occurrence.sourceRange.start;
  const duration = source.end - source.start;
  const offsetTime = source.startTime && occurrence.sourceRange.startTime
    ? subtractRationalTimes(source.startTime, occurrence.sourceRange.startTime)
    : secondsToRational(offset);
  return {
    start: occurrence.sequenceRange.start + offset,
    end: occurrence.sequenceRange.start + (source.end - occurrence.sourceRange.start),
    startTime: addRationalTimes(sequenceStartTime, offsetTime),
    durationTime: source.durationTime ? { ...source.durationTime } : secondsToRational(duration),
  };
}

function alignRange(range: TimeRange, frame: RationalTime): TimeRange {
  if (!range.startTime || !range.durationTime) throw new Error("ANALYSIS_INVALID: mapped sequence range is missing rational timing");
  const start = floorToFrame(range.startTime, frame);
  const end = ceilToFrame(addRationalTimes(range.startTime, range.durationTime), frame);
  return {
    start: rationalToNumber(start),
    end: rationalToNumber(end),
    startTime: start,
    durationTime: subtractRational(end, start),
  };
}

function validateOccurrence(occurrence: SpeechOccurrence): void {
  if (!occurrence.occurrenceId.trim()) throw new Error("ANALYSIS_INVALID: speech occurrence ID is required");
  if (!occurrence.mediaId.trim()) throw new Error("ANALYSIS_INVALID: speech occurrence media ID is required");
  validateRange(occurrence.sourceRange, "source occurrence range");
  validateRange(occurrence.sequenceRange, "sequence occurrence range");
}

function validateSequenceRationalRange(range: TimeRange): RationalTime {
  if (!range.startTime || !range.durationTime) {
    throw new Error("ANALYSIS_INVALID: sequence occurrence requires exact rational timing");
  }
  const start = validateRational(range.startTime, "ANALYSIS_INVALID", "sequence occurrence start time");
  const duration = validatePositiveRational(range.durationTime, "ANALYSIS_INVALID", "sequence occurrence duration time");
  if (Math.abs(rationalToNumber(start) - range.start) > 0.000000001
    || Math.abs(rationalToNumber(duration) - (range.end - range.start)) > 0.000000001) {
    throw new Error("AMBIGUOUS_MAPPING: sequence occurrence seconds and rational timing differ");
  }
  return start;
}

function validateRange(range: TimeRange, label: string): void {
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end <= range.start) {
    throw new Error(`ANALYSIS_INVALID: ${label} is invalid`);
  }
}

function validatePositiveRational(value: RationalTime, errorCode: string, label: string): RationalTime {
  const rational = validateRational(value, errorCode, label);
  if (parseRational(rational, errorCode).value <= 0n) throw new Error(`${errorCode}: ${label} must be positive`);
  return rational;
}

function validateRational(value: RationalTime, errorCode: string, label: string): RationalTime {
  try {
    parseRational(value, errorCode);
  } catch (error) {
    throw new Error(`${errorCode}: ${label} is invalid: ${String(error)}`);
  }
  return { value: value.value, timescale: value.timescale };
}

function relationToRange(value: { start: number; end: number }, range: TimeRange): "inside" | "outside" | "partial" {
  if (value.end <= range.start || value.start >= range.end) return "outside";
  if (value.start >= range.start && value.end <= range.end) return "inside";
  return "partial";
}

function containsRange(container: TimeRange, value: TimeRange): boolean {
  return value.start >= container.start - 0.000000001 && value.end <= container.end + 0.000000001;
}

function floorToFrame(value: RationalTime, frame: RationalTime): RationalTime {
  const valueParts = parseRational(value, "ANALYSIS_INVALID");
  const frameParts = parseRational(frame, "ANALYSIS_INVALID");
  const numerator = valueParts.value * frameParts.timescale;
  const denominator = valueParts.timescale * frameParts.value;
  const quotient = floorDivision(numerator, denominator);
  return normalizeRational(quotient * frameParts.value, frameParts.timescale);
}

function ceilToFrame(value: RationalTime, frame: RationalTime): RationalTime {
  const valueParts = parseRational(value, "ANALYSIS_INVALID");
  const frameParts = parseRational(frame, "ANALYSIS_INVALID");
  const numerator = valueParts.value * frameParts.timescale;
  const denominator = valueParts.timescale * frameParts.value;
  const quotient = floorDivision(numerator + denominator - 1n, denominator);
  return normalizeRational(quotient * frameParts.value, frameParts.timescale);
}

function floorDivision(numerator: bigint, denominator: bigint): bigint {
  if (numerator >= 0n) return numerator / denominator;
  return -((-numerator + denominator - 1n) / denominator);
}

function subtractRational(left: RationalTime, right: RationalTime): RationalTime {
  const leftParts = parseRational(left, "ANALYSIS_INVALID");
  const rightParts = parseRational(right, "ANALYSIS_INVALID");
  return normalizeRational(
    leftParts.value * rightParts.timescale - rightParts.value * leftParts.timescale,
    leftParts.timescale * rightParts.timescale,
  );
}

function rationalToNumber(value: RationalTime): number {
  const parts = parseRational(value, "ANALYSIS_INVALID");
  const result = Number(parts.value) / Number(parts.timescale);
  if (!Number.isFinite(result)) throw new Error("ANALYSIS_INVALID: rational mapping is outside supported range");
  return result;
}

function secondsToRational(seconds: number): RationalTime {
  const text = seconds.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  if (!text.includes(".")) return { value: text || "0", timescale: "1" };
  const [whole, fraction = ""] = text.split(".");
  const numerator = BigInt(`${whole}${fraction}`);
  const denominator = 10n ** BigInt(fraction.length);
  return normalizeRational(numerator, denominator);
}

function normalizeRational(value: bigint, timescale: bigint): RationalTime {
  const divisor = greatestCommonDivisor(value < 0n ? -value : value, timescale);
  return { value: String(value / divisor), timescale: String(timescale / divisor) };
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  while (right !== 0n) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left || 1n;
}

function sameRevision(left: ContextRevision, right: ContextRevision): boolean {
  return left.id === right.id && left.sequence === right.sequence && left.timestamp === right.timestamp;
}

function sameRational(left: RationalTime, right: RationalTime): boolean {
  const leftParts = parseRational(left, "ANALYSIS_INVALID");
  const rightParts = parseRational(right, "ANALYSIS_INVALID");
  return leftParts.value * rightParts.timescale === rightParts.value * leftParts.timescale;
}
