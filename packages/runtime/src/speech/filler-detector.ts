import { createHash } from "node:crypto";
import type { SpeechAnalysis, SpeechWord } from "../domain/media.js";
import type { TimeRange } from "../domain/primitives.js";

export const DEFAULT_FILLER_VOCABULARY = ["er", "erm", "hmm", "uh", "um"] as const;
export const DEFAULT_FILLER_CONFIDENCE_THRESHOLD = 0.92;

export type FillerReasonCode =
  | "ANALYZER_MARKED_FILLER"
  | "VOCABULARY_MATCH"
  | "BELOW_CONFIDENCE_THRESHOLD";

export interface FillerOccurrence {
  occurrenceId: string;
  mediaId?: string;
  sourceRange: TimeRange;
  sequenceRange: TimeRange;
}

export interface FillerDetectionInput {
  previewId: string;
  analysis: SpeechAnalysis;
  targetRange: TimeRange;
  occurrence: FillerOccurrence;
  revisionId?: string;
}

export interface FillerDetectorOptions {
  vocabulary?: readonly string[];
  confidenceThreshold?: number;
}

export interface FillerCandidateEvidence {
  word: SpeechWord;
  analyzerMarkedFiller: boolean;
  vocabularyMatch: boolean;
  withinTarget: boolean;
}

export interface FillerCandidate {
  id: string;
  word: SpeechWord;
  wordEvidence: SpeechWord;
  confidence: number;
  confidenceThreshold: number;
  eligible: boolean;
  occurrenceId: string;
  mediaId?: string;
  sourceRange: TimeRange;
  sequenceRange: TimeRange;
  reasonCodes: FillerReasonCode[];
  evidence: FillerCandidateEvidence;
}

/** Turn analyzer speech evidence into deterministic, preview-scoped candidates. */
export class FillerDetector {
  private readonly vocabulary: ReadonlySet<string>;
  private readonly confidenceThreshold: number;

  public constructor(options: FillerDetectorOptions = {}) {
    this.vocabulary = new Set((options.vocabulary ?? DEFAULT_FILLER_VOCABULARY).map(normalizeWord));
    this.confidenceThreshold = options.confidenceThreshold ?? DEFAULT_FILLER_CONFIDENCE_THRESHOLD;
    if (!Number.isFinite(this.confidenceThreshold)
      || this.confidenceThreshold < 0
      || this.confidenceThreshold > 1) {
      throw new Error("INVALID_OPERATION: filler confidence threshold must be between 0 and 1");
    }
  }

  public detect(input: FillerDetectionInput): FillerCandidate[] {
    validateInput(input);
    const words = orderAndValidateWords(input.analysis.words);
    const source = input.occurrence.sourceRange;
    const sequence = input.occurrence.sequenceRange;
    const sourceDuration = source.end - source.start;
    const sequenceDuration = sequence.end - sequence.start;
    if (Math.abs(sourceDuration - sequenceDuration) > 0.000001) {
      throw new Error("AMBIGUOUS_MAPPING: source and sequence occurrence durations differ");
    }

    return words.flatMap((word) => {
      const analyzerMarkedFiller = word.filler === true;
      const vocabularyMatch = this.vocabulary.has(normalizeWord(word.text));
      if (!analyzerMarkedFiller && !vocabularyMatch) return [];
      if (word.start < source.start || word.end > source.end) return [];

      const sequenceRange = {
        start: sequence.start + (word.start - source.start),
        end: sequence.start + (word.end - source.start),
      };
      const withinTarget = containsRange(input.targetRange, sequenceRange);
      if (!withinTarget) return [];

      const eligible = word.confidence >= this.confidenceThreshold;
      const reasonCodes: FillerReasonCode[] = [];
      if (analyzerMarkedFiller) reasonCodes.push("ANALYZER_MARKED_FILLER");
      if (vocabularyMatch) reasonCodes.push("VOCABULARY_MATCH");
      if (!eligible) reasonCodes.push("BELOW_CONFIDENCE_THRESHOLD");
      const sourceRange = { start: word.start, end: word.end };
      const candidate: FillerCandidate = {
        id: stableCandidateId(input, sourceRange),
        word: { ...word },
        wordEvidence: { ...word },
        confidence: word.confidence,
        confidenceThreshold: this.confidenceThreshold,
        eligible,
        occurrenceId: input.occurrence.occurrenceId,
        ...(input.occurrence.mediaId ? { mediaId: input.occurrence.mediaId } : {}),
        sourceRange,
        sequenceRange,
        reasonCodes,
        evidence: {
          word: { ...word },
          analyzerMarkedFiller,
          vocabularyMatch,
          withinTarget,
        },
      };
      return [candidate];
    });
  }
}

function validateInput(input: FillerDetectionInput): void {
  if (!input.previewId.trim()) throw new Error("INVALID_OPERATION: filler preview ID is required");
  validateRange(input.targetRange, "target range");
  validateRange(input.occurrence.sourceRange, "source occurrence range");
  validateRange(input.occurrence.sequenceRange, "sequence occurrence range");
  if (!input.occurrence.occurrenceId.trim()) {
    throw new Error("INVALID_OPERATION: filler occurrence ID is required");
  }
}

function orderAndValidateWords(words: SpeechWord[]): SpeechWord[] {
  const ordered = words
    .map((word) => ({ ...word }))
    .sort((left, right) => left.start - right.start || left.end - right.end || left.text.localeCompare(right.text));
  for (let index = 0; index < ordered.length; index += 1) {
    const word = ordered[index]!;
    if (!word.text.trim()
      || !Number.isFinite(word.start)
      || !Number.isFinite(word.end)
      || word.start < 0
      || word.end <= word.start
      || !Number.isFinite(word.confidence)
      || word.confidence < 0
      || word.confidence > 1) {
      throw new Error("ANALYSIS_INVALID: speech word boundaries or confidence");
    }
    const previous = ordered[index - 1];
    if (previous && previous.end > word.start) {
      throw new Error("ANALYSIS_INVALID: speech word boundaries overlap");
    }
  }
  return ordered;
}

function validateRange(range: TimeRange, label: string): void {
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start) {
    throw new Error(`INVALID_OPERATION: filler ${label} must be positive`);
  }
}

function containsRange(container: TimeRange, candidate: TimeRange): boolean {
  return candidate.start >= container.start && candidate.end <= container.end;
}

function normalizeWord(text: string): string {
  return text.trim().toLocaleLowerCase().replace(/[.,!?;:]+$/u, "");
}

function stableCandidateId(
  input: FillerDetectionInput,
  sourceRange: TimeRange,
): string {
  const identity = JSON.stringify({
    previewId: input.previewId,
    revisionId: input.revisionId ?? "",
    occurrenceId: input.occurrence.occurrenceId,
    mediaId: input.occurrence.mediaId ?? "",
    sourceRange,
  });
  return `filler-candidate-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}
