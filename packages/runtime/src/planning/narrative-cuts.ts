import { sameMediaSourceIdentity } from "../domain/media.js";
import type { MediaSourceIdentity, RevisionBoundSpeechAnalysis } from "../domain/media.js";
import type { ContextRevision, RationalTime, TimeRange } from "../domain/primitives.js";
import type { ProjectSnapshot } from "../domain/project.js";
import { bindSpeechAnalysis } from "../speech/analysis.js";
import { mapSpeechAnalysisToOccurrence } from "../speech/mapping.js";
import { addRationalTimes, parseRational, subtractRationalTimes } from "../timeline/rational-time.js";

export interface NarrativeCutRequest {
  source: MediaSourceIdentity;
  revision: ContextRevision;
  projectId: string;
  timelineId: string;
  occurrenceId: string;
  sourceRange: TimeRange;
  sequenceRange: TimeRange;
  sequenceFrameDuration: RationalTime;
  analysis: RevisionBoundSpeechAnalysis;
  /** Optional source-coordinate observations; visual gaps alone never propose cuts. */
  visualGaps?: TimeRange[];
}

export interface NarrativeCutCandidate {
  occurrenceId: string;
  sourceRange: TimeRange;
  sequenceRange: TimeRange;
  confidence: number;
  rationale: string;
  evidence: string[];
  reviewRequired: true;
}

export interface NarrativeCutPlan {
  projectId: string;
  timelineId: string;
  revision: ContextRevision;
  source: MediaSourceIdentity;
  candidates: NarrativeCutCandidate[];
  warnings: string[];
}

const PAD_SECONDS = 0.2;
const MIN_PAUSE_SECONDS = 0.8;
const MIN_WORD_CONFIDENCE = 0.8;
const END_OF_SENTENCE = /[.!?。！？]["'”’）)]*$/u;

function validRange(value: TimeRange | undefined): value is TimeRange {
  return !!value && Number.isFinite(value.start) && Number.isFinite(value.end) && value.start >= 0 && value.end > value.start;
}
function overlaps(left: TimeRange, right: TimeRange): boolean {
  return left.start < right.end && right.start < left.end;
}
function sameRevision(left: ContextRevision, right: ContextRevision): boolean {
  return !!left && !!right && left.id === right.id && left.sequence === right.sequence && left.timestamp === right.timestamp;
}
function validateRequest(request: NarrativeCutRequest): number {
  if (!request.source?.sourceDigest || !request.source.mediaId || !request.projectId?.trim() || !request.timelineId?.trim() || !request.occurrenceId?.trim()) throw new Error("TARGET_MISMATCH: source digest and occurrence are required");
  if (!request.analysis?.sourceIdentity || !sameMediaSourceIdentity(request.source, request.analysis.sourceIdentity)
    || request.analysis.mediaId !== request.source.mediaId) throw new Error("TARGET_MISMATCH: analysis source differs from the current source");
  if (!sameRevision(request.revision, request.analysis.revision)) throw new Error("STALE_CONTEXT: analysis revision differs from the current revision");
  if (!validRange(request.sourceRange) || !validRange(request.sequenceRange)) throw new Error("AMBIGUOUS_MAPPING: occurrence ranges are invalid");
  if (!request.sourceRange.startTime || !request.sourceRange.durationTime || !request.sequenceRange.startTime || !request.sequenceRange.durationTime) throw new Error("AMBIGUOUS_MAPPING: exact occurrence timing is required");
  if (Math.abs((request.sourceRange.end - request.sourceRange.start) - (request.sequenceRange.end - request.sequenceRange.start)) > 1e-9) throw new Error("AMBIGUOUS_MAPPING: retimed occurrences are unsupported");
  const frame = parseRational(request.sequenceFrameDuration, "ANALYSIS_INVALID");
  const seconds = Number(frame.value) / Number(frame.timescale);
  if (frame.value <= 0n || !Number.isFinite(seconds) || seconds <= 0) throw new Error("ANALYSIS_INVALID: sequence frame duration must be positive");
  return seconds;
}

/** Read-only recommendations; callers must separately bind evidence and approve any edit. */
export function rankNarrativeCuts(request: NarrativeCutRequest): NarrativeCutPlan {
  const frameSeconds = validateRequest(request);
  const result: NarrativeCutPlan = {
    projectId: request.projectId, timelineId: request.timelineId, revision: structuredClone(request.revision), source: structuredClone(request.source), candidates: [],
    warnings: ["Candidates require review and separate evidence-bound approval before any edit."],
  };
  if (!validRange(request.analysis.requestedRange) || !validRange(request.analysis.observedRange)
    || request.analysis.observedRange.start > request.sourceRange.start || request.analysis.observedRange.end < request.sourceRange.end
    || request.analysis.requestedRange.start > request.sourceRange.start || request.analysis.requestedRange.end < request.sourceRange.end
    || !request.analysis.vadSegments || request.analysis.capability !== "transcription-plus-vad") {
    result.warnings.push("Complete speech and VAD coverage for the occurrence is unavailable.");
    return result;
  }
  let mapping;
  try {
    const analysis = bindSpeechAnalysis(request.analysis, {
      input: { project: { revision: request.revision } as ProjectSnapshot, media: request.source }, provider: request.analysis.provider,
    });
    mapping = mapSpeechAnalysisToOccurrence(analysis, {
      occurrenceId: request.occurrenceId, mediaId: request.source.mediaId, revision: request.revision,
      sourceRange: request.sourceRange, sequenceRange: request.sequenceRange,
    }, { sequenceFrameDuration: request.sequenceFrameDuration });
  } catch (error) {
    result.warnings.push(`Speech mapping unavailable: ${error instanceof Error ? error.message : "invalid evidence"}`);
    return result;
  }
  if (!mapping.vadSegments || mapping.capability !== "transcription-plus-vad") {
    result.warnings.push("VAD coverage is partial or unavailable.");
    return result;
  }
  const words = [...mapping.words].sort((a, b) => a.sourceRange.start - b.sourceRange.start);
  const vad = mapping.vadSegments;
  const protectedRanges = mapping.protectedSegments ?? [];
  const gaps = request.visualGaps ?? [];
  if (request.visualGaps === undefined) result.warnings.push("Visual context is unavailable; ranking uses speech evidence only.");
  if (gaps.some((gap) => !validRange(gap))) {
    result.warnings.push("Visual gap evidence is invalid; no visual observations were used.");
  }
  for (let index = 0; index < words.length - 1; index++) {
    const previous = words[index]!;
    const next = words[index + 1]!;
    if (!END_OF_SENTENCE.test(previous.word.text.trim()) || previous.word.confidence < MIN_WORD_CONFIDENCE || next.word.confidence < MIN_WORD_CONFIDENCE) continue;
    const pause = { start: previous.sourceRange.end, end: next.sourceRange.start };
    if (!validRange(pause) || pause.end - pause.start < MIN_PAUSE_SECONDS) continue;
    if (words.some((entry) => overlaps(entry.sourceRange, pause)) || protectedRanges.some((entry) => overlaps(entry.sourceRange, pause))) continue;
    const silence = vad.find((entry) => entry.segment.kind === "silence" && entry.sourceRange.start <= pause.start && entry.sourceRange.end >= pause.end);
    if (!silence || vad.some((entry) => entry.segment.kind !== "silence" && overlaps(entry.sourceRange, pause))) continue;
    const rawStart = request.sequenceRange.start + (pause.start - request.sourceRange.start) + PAD_SECONDS;
    const rawEnd = request.sequenceRange.start + (pause.end - request.sourceRange.start) - PAD_SECONDS;
    const firstFrame = Math.ceil(rawStart / frameSeconds + 1e-8);
    const lastFrame = Math.floor(rawEnd / frameSeconds - 1e-8);
    if (!Number.isSafeInteger(firstFrame) || !Number.isSafeInteger(lastFrame) || lastFrame <= firstFrame) continue;
    const start = firstFrame * frameSeconds;
    const end = lastFrame * frameSeconds;
    if (start < rawStart || end > rawEnd) continue;
    const frame = parseRational(request.sequenceFrameDuration, "ANALYSIS_INVALID");
    const sequenceStart = { value: String(BigInt(firstFrame) * frame.value), timescale: String(frame.timescale) };
    const duration = { value: String(BigInt(lastFrame - firstFrame) * frame.value), timescale: String(frame.timescale) };
    const sourceRange = {
      start: request.sourceRange.start + (start - request.sequenceRange.start), end: request.sourceRange.start + (end - request.sequenceRange.start),
      startTime: addRationalTimes(request.sourceRange.startTime!, subtractRationalTimes(sequenceStart, request.sequenceRange.startTime!)),
      durationTime: duration,
    };
    const evidence = ["Sentence-ending transcript boundary", "VAD silence covers the pause", "Speech margins retained"];
    if (silence.segment.confidence === undefined && !result.warnings.includes("VAD silence confidence is unavailable.")) result.warnings.push("VAD silence confidence is unavailable.");
    if (gaps.every(validRange) && gaps.some((gap) => gap.start <= sourceRange.start && gap.end >= sourceRange.end)) evidence.push("Unverified visual gap hint overlaps the proposed interval");
    result.candidates.push({
      occurrenceId: request.occurrenceId, sourceRange,
      sequenceRange: { start, end, startTime: sequenceStart, durationTime: { ...duration } },
      confidence: Math.min(previous.word.confidence, next.word.confidence, silence.segment.confidence ?? 0.5),
      rationale: "A pause follows a sentence-ending word; review the surrounding thought and pacing before editing.",
      evidence, reviewRequired: true,
    });
  }
  result.candidates.sort((a, b) => b.confidence - a.confidence || Number(b.evidence.some((item) => item.startsWith("Unverified visual"))) - Number(a.evidence.some((item) => item.startsWith("Unverified visual"))) || a.sourceRange.start - b.sourceRange.start);
  return result;
}
