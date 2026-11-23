import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sameMediaSourceIdentity } from "../domain/media.js";
import type { MediaSourceIdentity, RevisionBoundSpeechAnalysis } from "../domain/media.js";
import type { ContextRevision, RationalTime, TimeRange } from "../domain/primitives.js";
import type { ProjectSnapshot } from "../domain/project.js";
import { bindSpeechAnalysis } from "../speech/analysis.js";
import { verifyAnalysisEvidence } from "./analysis-evidence.js";
import type { AnalysisArtifactStore, AnalysisEvidenceContext, AnalysisRef, AnalysisSourceVerifier } from "./analysis-evidence.js";
import type { MediaUnderstanding } from "../domain/media.js";
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
  /** Change detector for the proposal inputs, not an approval or source-byte proof. */
  inputDigest: string;
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
  const serialized = JSON.stringify(request, (_key, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  });
  const inputDigest = `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
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
    const corroborates = (range: TimeRange) => vad.some((entry) => entry.segment.kind === "speech" && entry.sourceRange.start <= range.start && entry.sourceRange.end >= range.end);
    if (!corroborates(previous.sourceRange) || !corroborates(next.sourceRange)) continue;
    const pause = { start: previous.sourceRange.end, end: next.sourceRange.start };
    if (!validRange(pause) || pause.end - pause.start < MIN_PAUSE_SECONDS) continue;
    if (words.some((entry) => overlaps(entry.sourceRange, pause)) || protectedRanges.some((entry) => overlaps(entry.sourceRange, pause))) continue;
    const silence = vad.find((entry) => entry.segment.kind === "silence" && entry.sourceRange.start <= pause.start && entry.sourceRange.end >= pause.end);
    const speechOnlyGap = !silence && vad.every((entry) => entry.segment.kind === "speech");
    if ((!silence && !speechOnlyGap) || vad.some((entry) => entry.segment.kind !== "silence" && overlaps(entry.sourceRange, pause))) continue;
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
    const evidence = ["Sentence-ending transcript boundary", silence ? "VAD silence covers the pause" : "VAD suggests a non-speech gap", "Speech margins retained"];
    if (speechOnlyGap && !result.warnings.includes("Non-speech gaps remain uncertain and require listening.")) result.warnings.push("Non-speech gaps remain uncertain and require listening.");
    if (silence?.segment.confidence === undefined && !result.warnings.includes("VAD silence confidence is unavailable.")) result.warnings.push("VAD silence confidence is unavailable.");
    if (gaps.every(validRange) && gaps.some((gap) => gap.start <= sourceRange.start && gap.end >= sourceRange.end)) evidence.push("Unverified visual gap hint overlaps the proposed interval");
    result.candidates.push({
      inputDigest, occurrenceId: request.occurrenceId, sourceRange,
      sequenceRange: { start, end, startTime: sequenceStart, durationTime: { ...duration } },
      confidence: Math.min(previous.word.confidence, next.word.confidence, silence?.segment.confidence ?? 0.5),
      rationale: "A pause follows a sentence-ending word; review the surrounding thought and pacing before editing.",
      evidence, reviewRequired: true,
    });
  }
  result.candidates.sort((a, b) => b.confidence - a.confidence || Number(b.evidence.some((item) => item.startsWith("Unverified visual"))) - Number(a.evidence.some((item) => item.startsWith("Unverified visual"))) || a.sourceRange.start - b.sourceRange.start);
  return result;
}

/** Recompute safety and permit a frame-aligned subrange of an issued suggestion. */
export function adjustNarrativeCut(
  request: NarrativeCutRequest,
  candidate: NarrativeCutCandidate,
  adjusted: TimeRange,
): NarrativeCutCandidate {
  const current = rankNarrativeCuts(request).candidates.find((item) => isDeepStrictEqual(item, candidate));
  if (!current) throw new Error("STALE_CANDIDATE: candidate no longer matches the current evidence or target");
  if (!validRange(adjusted) || !adjusted.startTime || !adjusted.durationTime) throw new Error("INVALID_CUT_RANGE: exact positive sequence timing is required");
  const start = parseRational(adjusted.startTime, "INVALID_CUT_RANGE");
  const duration = parseRational(adjusted.durationTime, "INVALID_CUT_RANGE");
  const frame = parseRational(request.sequenceFrameDuration, "INVALID_CUT_RANGE");
  if (start.value < 0n || duration.value <= 0n || frame.value <= 0n) throw new Error("INVALID_CUT_RANGE: invalid frame timing");
  const numericStart = Number(start.value) / Number(start.timescale);
  const numericDuration = Number(duration.value) / Number(duration.timescale);
  if (!Number.isFinite(numericStart) || !Number.isFinite(numericDuration)
    || Math.abs(numericStart - adjusted.start) > 1e-9 || Math.abs(numericStart + numericDuration - adjusted.end) > 1e-9) {
    throw new Error("INVALID_CUT_RANGE: numeric and exact timing differ");
  }
  if ((start.value * frame.timescale) % (start.timescale * frame.value) !== 0n
    || (duration.value * frame.timescale) % (duration.timescale * frame.value) !== 0n) {
    throw new Error("INVALID_CUT_RANGE: start and duration must align to the sequence frame grid");
  }
  const adjustedEnd = addRationalTimes(adjusted.startTime, adjusted.durationTime);
  const candidateEnd = addRationalTimes(current.sequenceRange.startTime!, current.sequenceRange.durationTime!);
  if (compareTimes(adjusted.startTime, current.sequenceRange.startTime!) < 0 || compareTimes(adjustedEnd, candidateEnd) > 0) {
    throw new Error("UNSAFE_CUT_RANGE: adjustment exceeds the validated speech-safe interval");
  }
  const sourceStart = addRationalTimes(request.sourceRange.startTime!, subtractRationalTimes(adjusted.startTime, request.sequenceRange.startTime!));
  const sourceStartParts = parseRational(sourceStart, "INVALID_CUT_RANGE");
  const sourceSeconds = Number(sourceStartParts.value) / Number(sourceStartParts.timescale);
  return {
    ...structuredClone(current),
    sourceRange: { start: sourceSeconds, end: sourceSeconds + numericDuration, startTime: sourceStart, durationTime: { ...adjusted.durationTime } },
    sequenceRange: structuredClone(adjusted),
    rationale: `${current.rationale} The interval was adjusted within the validated candidate.`,
  };
}

function compareTimes(left: RationalTime, right: RationalTime): number {
  const a = parseRational(left, "INVALID_CUT_RANGE");
  const b = parseRational(right, "INVALID_CUT_RANGE");
  const difference = a.value * b.timescale - b.value * a.timescale;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}


export type EvidenceBoundNarrativePlan =
  | { status: "available"; plan: NarrativeCutPlan; analysisRef: AnalysisRef }
  | { status: "unavailable"; reason: string };

type EvidenceLoad = { status: "available"; request: NarrativeCutRequest } | { status: "unavailable"; reason: string };

async function loadVerifiedRequest(
  request: Omit<NarrativeCutRequest, "analysis">,
  ref: AnalysisRef,
  current: AnalysisEvidenceContext,
  artifacts: AnalysisArtifactStore,
  verifySource: AnalysisSourceVerifier,
): Promise<EvidenceLoad> {
  try {
    if (current.kind !== "vad" || !sameMediaSourceIdentity(request.source, current.source)
      || !sameRevision(request.revision, current.revision) || !sameRevision(ref.analysisRevision, current.revision)
      || !validRange(request.sourceRange) || current.range.start > request.sourceRange.start || current.range.end < request.sourceRange.end) {
      return { status: "unavailable", reason: "Current target, revision, or VAD coverage is incompatible with the pinned analysis." };
    }
    const verified = await verifyAnalysisEvidence(artifacts, ref, current, verifySource);
    if (verified.status !== "verified") return { status: "unavailable", reason: verified.reason };
    // The store may change between reads, so independently check the exact bytes used below.
    const bytes = await artifacts.get(ref.artifactDigest);
    if (!bytes || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== ref.artifactDigest) {
      return { status: "unavailable", reason: "Pinned analysis artifact changed or disappeared." };
    }
    const record = JSON.parse(Buffer.from(bytes).toString("utf8")) as MediaUnderstanding;
    if (!record.speech) return { status: "unavailable", reason: "Pinned speech analysis is unavailable." };
    await verifySource(current.source);
    return { status: "available", request: { ...request, analysis: record.speech as RevisionBoundSpeechAnalysis } };
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Error ? error.message : "Evidence could not be verified." };
  }
}

/** Verify pinned VAD and rank its stored words; reverify before any write. */
export async function rankNarrativeCutsWithEvidence(
  request: Omit<NarrativeCutRequest, "analysis">,
  ref: AnalysisRef,
  current: AnalysisEvidenceContext,
  artifacts: AnalysisArtifactStore,
  verifySource: AnalysisSourceVerifier,
): Promise<EvidenceBoundNarrativePlan> {
  const loaded = await loadVerifiedRequest(request, ref, current, artifacts, verifySource);
  if (loaded.status !== "available") return loaded;
  try {
    return { status: "available", plan: rankNarrativeCuts(loaded.request), analysisRef: structuredClone(ref) };
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Error ? error.message : "Candidate planning failed." };
  }
}

export type EvidenceBoundNarrativeAdjustment =
  | { status: "available"; candidate: NarrativeCutCandidate; analysisRef: AnalysisRef }
  | { status: "unavailable"; reason: string };

/** Reverify the artifact and recompute the safe envelope before adjusting a proposal. */
export async function adjustNarrativeCutWithEvidence(
  request: Omit<NarrativeCutRequest, "analysis">,
  ref: AnalysisRef,
  current: AnalysisEvidenceContext,
  artifacts: AnalysisArtifactStore,
  verifySource: AnalysisSourceVerifier,
  candidate: NarrativeCutCandidate,
  adjusted: TimeRange,
): Promise<EvidenceBoundNarrativeAdjustment> {
  const loaded = await loadVerifiedRequest(request, ref, current, artifacts, verifySource);
  if (loaded.status !== "available") return loaded;
  try {
    return { status: "available", candidate: adjustNarrativeCut(loaded.request, candidate, adjusted), analysisRef: structuredClone(ref) };
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Error ? error.message : "Candidate adjustment failed." };
  }
}
