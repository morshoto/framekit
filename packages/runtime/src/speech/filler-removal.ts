import type { ContextRevision, RationalTime, TimeRange } from "../domain/primitives.js";
import type { EditOperation } from "../domain/editing.js";
import type { SpeechWord } from "../domain/media.js";
import type { TimelineDiff } from "../domain/diff.js";

export const DEFAULT_FILLER_CONFIDENCE = 0.92;
export const DEFAULT_PRESERVE_PAUSE_MS = 700;
export const DEFAULT_TARGET_PAUSE_MS = 500;

export interface FillerRemovalOptions {
  confidenceThreshold?: number;
  preservePauseMs?: number;
  targetPauseMs?: number;
}

export interface FillerRemovalCandidate {
  word: SpeechWord;
  range: TimeRange;
}

export interface FillerRemovalRequest extends FillerRemovalOptions {
  baseRevision: ContextRevision;
  range: TimeRange;
}

export interface FillerRemovalTarget extends FillerRemovalCandidate {
  clipId: string;
  mediaId: string;
  sourceRange: TimeRange;
}

export interface FillerRemovalPreview {
  previewToken: string;
  baseRevision: ContextRevision;
  range: TimeRange;
  candidates: FillerRemovalTarget[];
  operations: EditOperation[];
  expectedDiff?: TimelineDiff;
  warnings: string[];
  expiresAt: string;
}

/** Resolve transcript fillers into conservative, exact timeline ranges. */
export function planFillerRemoval(
  words: SpeechWord[],
  selectedRange: TimeRange,
  options: FillerRemovalOptions = {},
): FillerRemovalCandidate[] {
  validateRange(selectedRange);
  const confidenceThreshold = options.confidenceThreshold ?? DEFAULT_FILLER_CONFIDENCE;
  const preservePauseMs = options.preservePauseMs ?? DEFAULT_PRESERVE_PAUSE_MS;
  const targetPauseMs = options.targetPauseMs ?? DEFAULT_TARGET_PAUSE_MS;
  validateOptions(confidenceThreshold, preservePauseMs, targetPauseMs);

  const orderedWords = words
    .map((word) => ({ ...word }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 0; index < orderedWords.length; index += 1) {
    const word = orderedWords[index]!;
    if (!word.text.trim() || !Number.isFinite(word.start) || !Number.isFinite(word.end)
      || word.start < 0 || word.end <= word.start || !Number.isFinite(word.confidence)) {
      throw new Error("ANALYSIS_INVALID: speech word boundaries or confidence");
    }
    const previous = orderedWords[index - 1];
    if (previous && previous.end > word.start) {
      throw new Error("ANALYSIS_INVALID: speech word boundaries overlap");
    }
  }

  return orderedWords
    .map((word, index) => ({ word, index }))
    .filter(({ word }) => word.filler === true
      && word.confidence >= confidenceThreshold
      && word.start >= selectedRange.start
      && word.end <= selectedRange.end)
    .map(({ word, index }) => ({
      word,
      range: resolveSafeRange(orderedWords, index, word, preservePauseMs, targetPauseMs),
    }))
    .sort((left, right) => right.range.start - left.range.start);
}

function resolveSafeRange(
  words: SpeechWord[],
  index: number,
  word: SpeechWord,
  preservePauseMs: number,
  targetPauseMs: number,
): TimeRange {
  let end = word.end;
  const previous = words[index - 1];
  const next = words[index + 1];
  const hasAdjacentSpeech = previous?.filler !== true && next?.filler !== true;
  const followingPauseMs = next ? (next.start - word.end) * 1000 : 0;
  if (hasAdjacentSpeech && followingPauseMs > preservePauseMs) {
    end += (followingPauseMs - targetPauseMs) / 1000;
  }
  return {
    start: word.start,
    end,
    startTime: secondsToRational(word.start),
    durationTime: secondsToRational(end - word.start),
  };
}

function validateRange(range: TimeRange): void {
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end)
    || range.start < 0 || range.end <= range.start) {
    throw new Error("INVALID_OPERATION: filler selection range must be positive");
  }
}

function validateOptions(confidenceThreshold: number, preservePauseMs: number, targetPauseMs: number): void {
  if (!Number.isFinite(confidenceThreshold) || confidenceThreshold < 0 || confidenceThreshold > 1) {
    throw new Error("INVALID_OPERATION: filler confidence threshold must be between 0 and 1");
  }
  if (!Number.isFinite(preservePauseMs) || preservePauseMs < 0
    || !Number.isFinite(targetPauseMs) || targetPauseMs < 0 || targetPauseMs > preservePauseMs) {
    throw new Error("INVALID_OPERATION: filler pause settings must be non-negative and target pause cannot exceed preserved pause");
  }
}

function secondsToRational(seconds: number): RationalTime {
  const text = seconds.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  if (!text.includes(".")) return { value: text || "0", timescale: "1" };
  const [whole, fraction = ""] = text.split(".");
  let numerator = BigInt(`${whole}${fraction}`);
  let denominator = 10n ** BigInt(fraction.length);
  const divisor = greatestCommonDivisor(numerator < 0n ? -numerator : numerator, denominator);
  numerator /= divisor;
  denominator /= divisor;
  return { value: String(numerator), timescale: String(denominator) };
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  while (right !== 0n) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left || 1n;
}
