import type { SpeechAnalysis, SpeechSegment, SpeechWord } from "../domain/media.js";
import type { EditOperation } from "../domain/editing.js";
import type { RationalTime, TimeRange } from "../domain/primitives.js";
import type { FillerCandidate, FillerOccurrence } from "./filler-detector.js";

export const DEFAULT_SAFE_CUT_PRESERVE_PAUSE_MS = 700;
export const DEFAULT_SAFE_CUT_TARGET_PAUSE_MS = 500;

export type SafeCutStatus = "AUTO_APPLY" | "SUGGESTED" | "SKIPPED";

export type SafeCutReasonCode =
  | "SAFE_BOUNDARY_RESOLVED"
  | "PAUSE_PRESERVED"
  | "LOW_CONFIDENCE"
  | "MISSING_VAD_EVIDENCE"
  | "INVALID_VAD_EVIDENCE"
  | "AMBIGUOUS_MAPPING"
  | "OVERLAPPING_SPEECH"
  | "PROTECTED_SEGMENT_OVERLAP"
  | "OUTSIDE_TARGET_BOUND"
  | "OUTSIDE_OCCURRENCE_BOUND"
  | "NO_FRAME_ALIGNED_RANGE";

export interface SafeCutResolverOptions {
  preservePauseMs?: number;
  targetPauseMs?: number;
}

export interface SafeCutRequest {
  candidate: FillerCandidate;
  analysis: SpeechAnalysis;
  targetRange: TimeRange;
  occurrence: FillerOccurrence;
  timelineId: string;
  sequenceFrameDuration: RationalTime;
}

export interface SafeCutEvidence {
  word: SpeechWord;
  previousWord?: SpeechWord;
  nextWord?: SpeechWord;
  speechSegments: SpeechSegment[];
  silenceSegments: SpeechSegment[];
  protectedSegments: SpeechSegment[];
  occurrenceRange: TimeRange;
  targetRange: TimeRange;
  frameDuration: RationalTime;
  pauseBeforeCutMs: number;
  pauseAfterCutMs: number;
  safeRange?: TimeRange;
}

export interface SafeCutDecision {
  status: SafeCutStatus;
  candidateId: string;
  occurrenceId: string;
  reasonCodes: SafeCutReasonCode[];
  evidence: SafeCutEvidence;
  range?: TimeRange;
  operation?: Extract<EditOperation, { type: "ripple-delete" }>;
}

/** Resolve filler words to safe frame-aligned operations without mutating an editor. */
export class SafeCutResolver {
  private readonly preservePauseMs: number;
  private readonly targetPauseMs: number;

  public constructor(options: SafeCutResolverOptions = {}) {
    this.preservePauseMs = options.preservePauseMs ?? DEFAULT_SAFE_CUT_PRESERVE_PAUSE_MS;
    this.targetPauseMs = options.targetPauseMs ?? DEFAULT_SAFE_CUT_TARGET_PAUSE_MS;
    if (!Number.isFinite(this.preservePauseMs)
      || this.preservePauseMs < 0
      || !Number.isFinite(this.targetPauseMs)
      || this.targetPauseMs < 0
      || this.targetPauseMs > this.preservePauseMs) {
      throw new Error("INVALID_OPERATION: safe cut pause settings are invalid");
    }
  }

  public resolve(request: SafeCutRequest): SafeCutDecision {
    const evidence = createEvidence(request);
    const base = {
      candidateId: request.candidate.id,
      occurrenceId: request.occurrence.occurrenceId,
      evidence,
    };
    const initialReasons: SafeCutReasonCode[] = [];

    if (request.candidate.occurrenceId !== request.occurrence.occurrenceId) {
      return { ...base, status: "SKIPPED", reasonCodes: ["AMBIGUOUS_MAPPING"] };
    }
    if (!isContained(request.candidate.sequenceRange, request.targetRange)) {
      return { ...base, status: "SKIPPED", reasonCodes: ["OUTSIDE_TARGET_BOUND"] };
    }
    if (!isContained(request.candidate.sequenceRange, request.occurrence.sequenceRange)) {
      return { ...base, status: "SKIPPED", reasonCodes: ["OUTSIDE_OCCURRENCE_BOUND"] };
    }
    if (!isSequenceMappingConsistent(request.candidate, request.occurrence)) {
      return { ...base, status: "SKIPPED", reasonCodes: ["AMBIGUOUS_MAPPING"] };
    }

    const frame = parseRational(request.sequenceFrameDuration);
    if (!frame || frame.numerator <= 0n) {
      return { ...base, status: "SKIPPED", reasonCodes: ["NO_FRAME_ALIGNED_RANGE"] };
    }
    const words = orderWords(request.analysis.words);
    if (!words) {
      return { ...base, status: "SKIPPED", reasonCodes: ["OVERLAPPING_SPEECH"] };
    }
    const wordMatches = words.filter((word) => sameWord(word, request.candidate.word));
    if (wordMatches.length !== 1) {
      return { ...base, status: "SKIPPED", reasonCodes: ["AMBIGUOUS_MAPPING"] };
    }
    const wordIndex = words.indexOf(wordMatches[0]!);
    const word = wordMatches[0]!;
    const previousWord = words[wordIndex - 1];
    const nextWord = words[wordIndex + 1];
    evidence.word = { ...word };
    if (previousWord) evidence.previousWord = { ...previousWord };
    if (nextWord) evidence.nextWord = { ...nextWord };

    if (!request.analysis.vadSegments) {
      return { ...base, status: "SKIPPED", reasonCodes: ["MISSING_VAD_EVIDENCE"] };
    }
    const vadSegments = validateSegments(request.analysis.vadSegments);
    if (!vadSegments) {
      return { ...base, status: "SKIPPED", reasonCodes: ["INVALID_VAD_EVIDENCE"] };
    }
    evidence.speechSegments = vadSegments.filter((segment) => segment.kind === "speech");
    if (hasOverlappingSpeech(vadSegments) || hasOverlappingWords(words)) {
      return { ...base, status: "SKIPPED", reasonCodes: ["OVERLAPPING_SPEECH"] };
    }
    if (!coversRange(evidence.speechSegments, request.candidate.sourceRange)) {
      return { ...base, status: "SKIPPED", reasonCodes: ["MISSING_VAD_EVIDENCE"] };
    }

    const silenceSegments = validateSegments([
      ...(request.analysis.silenceSegments ?? []),
      ...vadSegments.filter((segment) => segment.kind === "silence"),
    ]);
    if (!silenceSegments) {
      return { ...base, status: "SKIPPED", reasonCodes: ["INVALID_VAD_EVIDENCE"] };
    }
    evidence.silenceSegments = silenceSegments;
    const protectedSegments = validateSegments(request.analysis.protectedSegments ?? []);
    if (!protectedSegments) {
      return { ...base, status: "SKIPPED", reasonCodes: ["INVALID_VAD_EVIDENCE"] };
    }
    evidence.protectedSegments = protectedSegments;
    if (overlapsAny(protectedSegments, request.candidate.sourceRange)) {
      return { ...base, status: "SKIPPED", reasonCodes: ["PROTECTED_SEGMENT_OVERLAP"] };
    }

    const nextStart = nextWord?.start ?? request.occurrence.sourceRange.end;
    const followingPauseMs = Math.max(0, (nextStart - word.end) * 1000);
    evidence.pauseBeforeCutMs = Math.max(0, (word.start - (previousWord?.end ?? word.start)) * 1000);
    let sourceEnd = word.end;
    let pauseReason = false;
    if (followingPauseMs > this.preservePauseMs) {
      const silenceEnd = silenceEndFor(silenceSegments, word.end, nextStart);
      const desiredEnd = word.end + (followingPauseMs - this.targetPauseMs) / 1000;
      if (silenceEnd !== undefined && silenceEnd >= desiredEnd) {
        sourceEnd = Math.min(desiredEnd, nextStart);
        pauseReason = true;
      }
    }
    evidence.pauseAfterCutMs = Math.max(0, (nextStart - sourceEnd) * 1000);
    if (overlapsAny(protectedSegments, { start: word.start, end: sourceEnd })) {
      return { ...base, status: "SKIPPED", reasonCodes: ["PROTECTED_SEGMENT_OVERLAP"] };
    }

    const sourceStart = word.start;
    const minimumSourceStart = previousWord
      ? Math.max(previousWord.end, request.occurrence.sourceRange.start)
      : request.occurrence.sourceRange.start;
    const sequenceStart = mapSourceToSequence(sourceStart, request.occurrence);
    const sequenceEnd = mapSourceToSequence(sourceEnd, request.occurrence);
    const minimumSequenceStart = Math.max(
      mapSourceToSequence(minimumSourceStart, request.occurrence),
      request.targetRange.start,
      request.occurrence.sequenceRange.start,
    );
    const maximumSequenceEnd = Math.min(
      mapSourceToSequence(nextStart, request.occurrence),
      request.targetRange.end,
      request.occurrence.sequenceRange.end,
    );
    const alignedStart = floorMultiple(decimalToRational(sequenceStart), frame);
    const alignedEnd = ceilMultiple(decimalToRational(sequenceEnd), frame);
    const safeStart = rationalToNumber(alignedStart);
    const safeEnd = rationalToNumber(alignedEnd);
    if (!Number.isFinite(safeStart)
      || !Number.isFinite(safeEnd)
      || safeEnd <= safeStart
      || safeStart < minimumSequenceStart - 0.000000001
      || safeEnd > maximumSequenceEnd + 0.000000001) {
      return { ...base, status: "SKIPPED", reasonCodes: ["NO_FRAME_ALIGNED_RANGE"] };
    }

    const range = rangeFromRationals(alignedStart, subtractRationals(alignedEnd, alignedStart));
    evidence.safeRange = structuredClone(range);
    initialReasons.push("SAFE_BOUNDARY_RESOLVED");
    if (pauseReason) initialReasons.push("PAUSE_PRESERVED");
    if (!request.candidate.eligible || request.candidate.confidence < request.candidate.confidenceThreshold) {
      initialReasons.push("LOW_CONFIDENCE");
    }
    const status: SafeCutStatus = initialReasons.includes("LOW_CONFIDENCE") ? "SUGGESTED" : "AUTO_APPLY";
    return {
      ...base,
      status,
      reasonCodes: initialReasons,
      range,
      operation: {
        type: "ripple-delete",
        timelineId: request.timelineId,
        range: structuredClone(range),
        reason: `remove filler candidate ${request.candidate.id}`,
      },
    };
  }
}

interface RationalParts {
  numerator: bigint;
  denominator: bigint;
}

function createEvidence(request: SafeCutRequest): SafeCutEvidence {
  return {
    word: { ...request.candidate.word },
    speechSegments: [],
    silenceSegments: [],
    protectedSegments: [],
    occurrenceRange: structuredClone(request.occurrence.sequenceRange),
    targetRange: structuredClone(request.targetRange),
    frameDuration: structuredClone(request.sequenceFrameDuration),
    pauseBeforeCutMs: 0,
    pauseAfterCutMs: 0,
  };
}

function validateSegments(segments: SpeechSegment[] | undefined): SpeechSegment[] | undefined {
  if (!segments) return undefined;
  const ordered = segments.map((segment) => ({ ...segment })).sort((left, right) => left.start - right.start || left.end - right.end);
  for (const segment of ordered) {
    if (!Number.isFinite(segment.start)
      || !Number.isFinite(segment.end)
      || segment.start < 0
      || segment.end <= segment.start
      || !["speech", "silence", "breath", "laughter", "noise"].includes(segment.kind)) {
      return undefined;
    }
  }
  return ordered;
}

function orderWords(words: SpeechWord[]): SpeechWord[] | undefined {
  const ordered = words.map((word) => ({ ...word })).sort((left, right) => left.start - right.start || left.end - right.end);
  return hasOverlappingWords(ordered) ? undefined : ordered;
}

function hasOverlappingWords(words: SpeechWord[]): boolean {
  return words.some((word, index) => index > 0 && words[index - 1]!.end > word.start);
}

function hasOverlappingSpeech(segments: SpeechSegment[]): boolean {
  const speech = segments.filter((segment) => segment.kind === "speech");
  return speech.some((segment, index) => index > 0 && speech[index - 1]!.end > segment.start);
}

function coversRange(segments: SpeechSegment[], range: TimeRange): boolean {
  return segments.some((segment) => segment.start <= range.start && segment.end >= range.end);
}

function overlapsAny(segments: SpeechSegment[], range: TimeRange): boolean {
  return segments.some((segment) => segment.start < range.end && segment.end > range.start);
}

function silenceEndFor(segments: SpeechSegment[], start: number, end: number): number | undefined {
  return segments
    .filter((segment) => segment.kind === "silence" && segment.start <= start && segment.end >= end)
    .map((segment) => segment.end)
    .sort((left, right) => right - left)[0];
}

function sameWord(left: SpeechWord, right: SpeechWord): boolean {
  return left.text === right.text && left.start === right.start && left.end === right.end;
}

function isContained(candidate: TimeRange, container: TimeRange): boolean {
  return candidate.start >= container.start && candidate.end <= container.end;
}

function isSequenceMappingConsistent(candidate: FillerCandidate, occurrence: FillerOccurrence): boolean {
  const expectedStart = mapSourceToSequence(candidate.sourceRange.start, occurrence);
  const expectedEnd = mapSourceToSequence(candidate.sourceRange.end, occurrence);
  return Math.abs(expectedStart - candidate.sequenceRange.start) <= 0.000001
    && Math.abs(expectedEnd - candidate.sequenceRange.end) <= 0.000001;
}

function mapSourceToSequence(sourceTime: number, occurrence: FillerOccurrence): number {
  return occurrence.sequenceRange.start + (sourceTime - occurrence.sourceRange.start);
}

function parseRational(time: RationalTime): RationalParts | undefined {
  if (!/^-?\d+$/.test(time.value) || !/^\d+$/.test(time.timescale)) return undefined;
  const denominator = BigInt(time.timescale);
  if (denominator <= 0n) return undefined;
  return normalizeRational({ numerator: BigInt(time.value), denominator });
}

function decimalToRational(value: number): RationalParts {
  const text = value.toString();
  if (/[eE]/u.test(text)) {
    const [coefficient, exponentText] = text.split(/[eE]/u);
    const exponent = Number(exponentText);
    const coefficientParts = decimalToRational(Number(coefficient));
    if (exponent >= 0) return normalizeRational({ numerator: coefficientParts.numerator * 10n ** BigInt(exponent), denominator: coefficientParts.denominator });
    return normalizeRational({ numerator: coefficientParts.numerator, denominator: coefficientParts.denominator * 10n ** BigInt(-exponent) });
  }
  const [whole, fraction = ""] = text.split(".");
  const sign = whole.startsWith("-") ? -1n : 1n;
  const unsignedWhole = whole.replace(/^-/, "");
  return normalizeRational({
    numerator: sign * BigInt(`${unsignedWhole}${fraction}` || "0"),
    denominator: 10n ** BigInt(fraction.length),
  });
}

function normalizeRational(value: RationalParts): RationalParts {
  const divisor = greatestCommonDivisor(value.numerator < 0n ? -value.numerator : value.numerator, value.denominator);
  return { numerator: value.numerator / divisor, denominator: value.denominator / divisor };
}

function floorMultiple(value: RationalParts, multiple: RationalParts): RationalParts {
  const quotient = floorDivide(value.numerator * multiple.denominator, value.denominator * multiple.numerator);
  return normalizeRational({ numerator: quotient * multiple.numerator, denominator: multiple.denominator });
}

function ceilMultiple(value: RationalParts, multiple: RationalParts): RationalParts {
  const numerator = value.numerator * multiple.denominator;
  const denominator = value.denominator * multiple.numerator;
  const quotient = ceilDivide(numerator, denominator);
  return normalizeRational({ numerator: quotient * multiple.numerator, denominator: multiple.denominator });
}

function floorDivide(numerator: bigint, denominator: bigint): bigint {
  if (numerator >= 0n) return numerator / denominator;
  return -((-numerator + denominator - 1n) / denominator);
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  if (numerator >= 0n) return (numerator + denominator - 1n) / denominator;
  return -((-numerator) / denominator);
}

function subtractRationals(left: RationalParts, right: RationalParts): RationalParts {
  return normalizeRational({
    numerator: left.numerator * right.denominator - right.numerator * left.denominator,
    denominator: left.denominator * right.denominator,
  });
}

function rangeFromRationals(start: RationalParts, duration: RationalParts): TimeRange {
  const end = normalizeRational({
    numerator: start.numerator * duration.denominator + duration.numerator * start.denominator,
    denominator: start.denominator * duration.denominator,
  });
  return {
    start: rationalToNumber(start),
    end: rationalToNumber(end),
    startTime: rationalToTime(start),
    durationTime: rationalToTime(duration),
  };
}

function rationalToNumber(value: RationalParts): number {
  return Number(value.numerator) / Number(value.denominator);
}

function rationalToTime(value: RationalParts): RationalTime {
  return { value: String(value.numerator), timescale: String(value.denominator) };
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  while (right !== 0n) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left || 1n;
}
