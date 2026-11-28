import { createHash } from "node:crypto";
import { sameMediaSourceIdentity } from "../domain/media.js";
import type { MediaUnderstanding, RevisionBoundSpeechAnalysis, SpeechWord } from "../domain/media.js";
import type { ContextRevision, TimeRange } from "../domain/primitives.js";
import type { ProjectSnapshot } from "../domain/project.js";
import { bindSpeechAnalysis } from "../speech/analysis.js";
import { mapSpeechAnalysisToOccurrence } from "../speech/mapping.js";
import { addRationalTimes, parseRational, subtractRationalTimes } from "../timeline/rational-time.js";
import { verifyAnalysisEvidence } from "./analysis-evidence.js";
import type { AnalysisArtifactStore, AnalysisEvidenceContext, AnalysisRef, AnalysisSourceVerifier } from "./analysis-evidence.js";

export interface CaptionPlanRequest {
  snapshot: ProjectSnapshot;
  projectId: string;
  timelineId: string;
  revision: ContextRevision;
  occurrenceId: string;
  style: string;
  maxWordsPerGroup: number;
  maxCharsPerLine: number;
  maxLines: number;
  emphasisWordIndices?: number[];
  /** Review-supplied text, keyed to the pinned transcript; never changes source evidence or timing. */
  wordCorrections?: Array<{ wordIndex: number; text: string }>;
  /** Explicit separator allows scripts that do not use spaces between words. */
  wordSeparator?: " " | "";
}
export interface CaptionWord {
  wordIndex: number;
  text: string;
  originalText?: string;
  confidence: number;
  sourceRange: TimeRange;
  sequenceRange: TimeRange;
  frameAlignedRange: TimeRange;
}
export interface CaptionGroup {
  lines: string[];
  words: CaptionWord[];
  sequenceRange: TimeRange;
  emphasis: { wordIndex: number; reason: string }[];
}
export interface CaptionPlan {
  projectId: string;
  timelineId: string;
  occurrenceId: string;
  revision: ContextRevision;
  analysisRef: AnalysisRef;
  inputDigest: string;
  groups: CaptionGroup[];
  warnings: string[];
  reviewRequired: true;
  nativeTitleStatus: "unavailable";
}
export type CaptionPlanResult =
  | { status: "available"; plan: CaptionPlan }
  | { status: "unavailable" | "unsupported"; reason: string };

function sameRevision(a: ContextRevision, b: ContextRevision): boolean {
  return !!a && !!b && a.id === b.id && a.sequence === b.sequence && a.timestamp === b.timestamp;
}
function seconds(value: { value: string; timescale: string }): number {
  const parsed = parseRational(value, "ANALYSIS_INVALID");
  const n = Number(parsed.value) / Number(parsed.timescale);
  if (!Number.isFinite(n)) throw new Error("ANALYSIS_INVALID: invalid exact timing");
  return n;
}
function count(text: string): number { return Array.from(text).length; }
function digest(value: unknown): string {
  const json = JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
  return `sha256:${createHash("sha256").update(json).digest("hex")}`;
}

/** Plan review-only caption groups from a pinned transcript and current snapshot. */
export async function planCaptionGroups(
  request: CaptionPlanRequest,
  ref: AnalysisRef,
  current: AnalysisEvidenceContext,
  artifacts: AnalysisArtifactStore,
  verifySource: AnalysisSourceVerifier,
): Promise<CaptionPlanResult> {
  try {
    request = structuredClone(request);
    ref = structuredClone(ref);
    current = structuredClone(current);
    if (typeof verifySource === "function") {
      const delegate = verifySource;
      verifySource = (source) => delegate(structuredClone(source));
    }
    if (request.style !== "basic") return { status: "unsupported", reason: "Only basic caption groups are planned; requested styling or animation is unsupported." };
    if (!Number.isSafeInteger(request.maxWordsPerGroup) || request.maxWordsPerGroup < 1 || request.maxWordsPerGroup > 20
      || !Number.isSafeInteger(request.maxCharsPerLine) || request.maxCharsPerLine < 1 || request.maxCharsPerLine > 100
      || !Number.isSafeInteger(request.maxLines) || request.maxLines < 1 || request.maxLines > 2
      || (request.wordSeparator !== undefined && request.wordSeparator !== " " && request.wordSeparator !== "")) {
      return { status: "unsupported", reason: "Caption grouping options are invalid or unsupported." };
    }
    const snapshot = request.snapshot;
    if (!snapshot || !request.projectId?.trim() || !request.timelineId?.trim() || !request.occurrenceId?.trim()
      || snapshot.projectId !== request.projectId || snapshot.timeline.id !== request.timelineId
      || !sameRevision(snapshot.revision, request.revision) || !sameRevision(current.revision, request.revision)
      || current.kind !== "speech") {
      return { status: "unavailable", reason: "Current project, timeline, revision or speech evidence does not match." };
    }
    const clips = snapshot.timeline.clips.filter((clip) => clip.id === request.occurrenceId);
    const media = snapshot.media.filter((item) => item.mediaId === current.source.mediaId);
    const clip = clips.length === 1 ? clips[0] : undefined;
    if (!clip || clip.mediaId !== current.source.mediaId || media.length !== 1 || !sameMediaSourceIdentity(media[0]!, current.source)
      || !clip.startTime || !clip.durationTime || !snapshot.timeline.frameDuration
      || (clip.sourceStart !== undefined && clip.sourceStart !== 0 && !clip.sourceStartTime)
      || (snapshot.timeline.frameGridOrigin && seconds(snapshot.timeline.frameGridOrigin) !== 0)) {
      return { status: "unavailable", reason: "Exact unique source occurrence and supported frame grid are required." };
    }
    const sourceStartTime = clip.sourceStartTime ?? { value: "0", timescale: "1" };
    const sourceStart = clip.sourceStart ?? 0;
    const sourceRange = { start: sourceStart, end: sourceStart + clip.duration, startTime: sourceStartTime, durationTime: clip.durationTime };
    if (current.range.start > sourceRange.start || current.range.end < sourceRange.end) return { status: "unavailable", reason: "Pinned transcript does not cover the occurrence." };
    const verified = await verifyAnalysisEvidence(artifacts, ref, current, verifySource);
    if (verified.status !== "verified") return { status: "unavailable", reason: verified.reason };
    const bytes = await artifacts.get(ref.artifactDigest);
    if (!bytes || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== ref.artifactDigest) return { status: "unavailable", reason: "Pinned transcript changed or disappeared." };
    const record = JSON.parse(Buffer.from(bytes).toString("utf8")) as MediaUnderstanding;
    if (!record.speech) return { status: "unavailable", reason: "Pinned transcript is missing." };
    await verifySource(current.source);
    const original = bindSpeechAnalysis(record.speech, {
      input: { project: { ...snapshot, revision: ref.analysisRevision }, media: current.source }, provider: current.provider,
    });
    const analysis = { ...original, revision: structuredClone(request.revision) };
    const mapping = mapSpeechAnalysisToOccurrence(analysis, {
      occurrenceId: clip.id, mediaId: current.source.mediaId, revision: request.revision, sourceRange,
      sequenceRange: { start: clip.start, end: clip.start + clip.duration, startTime: clip.startTime, durationTime: clip.durationTime },
    }, { sequenceFrameDuration: snapshot.timeline.frameDuration });
    const corrections = request.wordCorrections ?? [];
    if (!Array.isArray(corrections) || corrections.length > 500 || corrections.some((item) => !item || !Number.isSafeInteger(item.wordIndex)
      || item.wordIndex < 0 || item.wordIndex >= analysis.words.length || typeof item.text !== "string" || !item.text.trim()
      || item.text !== item.text.trim() || /[\r\n\u0000-\u001f]/u.test(item.text) || count(item.text) > request.maxCharsPerLine)
      || new Set(corrections.map((item) => item.wordIndex)).size !== corrections.length) {
      return { status: "unsupported", reason: "Caption corrections must identify unique transcript words and valid replacement text." };
    }
    const selected = request.emphasisWordIndices ?? [];
    if (!Array.isArray(selected) || new Set(selected).size !== selected.length || selected.some((n) => !Number.isSafeInteger(n) || n < 0 || n >= analysis.words.length)) return { status: "unsupported", reason: "Emphasis must identify unique transcript words." };
    const mapped = mapping.words.map((item) => {
      const index = analysis.words.findIndex((word) => sameWord(word, item.word));
      if (index < 0) throw new Error("ANALYSIS_INVALID: transcript word identity is ambiguous");
      const correction = corrections.find((entry) => entry.wordIndex === index);
      return { wordIndex: index, text: correction?.text ?? item.word.text, ...(correction ? { originalText: item.word.text } : {}),
        confidence: item.word.confidence, sourceRange: item.sourceRange, sequenceRange: item.sequenceRange, frameAlignedRange: item.frameAlignedRange };
    }).sort((a, b) => a.sequenceRange.start - b.sequenceRange.start);
    if (selected.some((index) => !mapped.some((word) => word.wordIndex === index))) return { status: "unavailable", reason: "An emphasized word is outside the mapped occurrence." };
    if (corrections.some((item) => !mapped.some((word) => word.wordIndex === item.wordIndex))) return { status: "unavailable", reason: "A corrected word is outside the mapped occurrence." };
    const separator = request.wordSeparator ?? " ";
    let grouped: CaptionWord[][] = [];
    let currentWords: CaptionWord[] = [];
    for (const word of mapped) {
      if (/[\r\n\u0000-\u001f]/u.test(word.text) || count(word.text) > request.maxCharsPerLine) return { status: "unsupported", reason: "A transcript word cannot fit the requested basic caption format." };
      const trial = [...currentWords, word];
      const fits = wrap(trial, separator, request.maxCharsPerLine, request.maxLines) !== undefined;
      if (currentWords.length && (trial.length > request.maxWordsPerGroup || !fits || /[.!?。！？]["'”’）)]*$/u.test(currentWords[currentWords.length - 1]!.text))) {
        grouped.push(currentWords);
        currentWords = [word];
      } else currentWords = trial;
    }
    if (currentWords.length) grouped.push(currentWords);
    const warnings = ["Transcript and emphasis require human review; native editable title support is not established."];
    let sampledTiming = false;
    if (grouped.some((words, i) => i > 0 && grouped[i - 1]![grouped[i - 1]!.length - 1]!.frameAlignedRange.end > words[0]!.frameAlignedRange.start + 1e-9)) {
      const alternative = frameSafeGroups(mapped, separator, request.maxWordsPerGroup, request.maxCharsPerLine, request.maxLines);
      if (alternative) {
        grouped = alternative;
        warnings.push("Caption boundaries were regrouped to avoid frame overlap; review sentence breaks.");
      } else {
        const sampled = mapped.map((word) => {
          const range = sampledFrameRange(word.sequenceRange, snapshot.timeline.frameDuration!);
          return range && { ...word, frameAlignedRange: range };
        });
        if (sampled.some((word) => !word)) return { status: "unavailable", reason: "Caption timing cannot be mapped to the sequence frame grid." };
        const sampledGroups = frameSafeGroups(sampled as CaptionWord[], separator, request.maxWordsPerGroup, request.maxCharsPerLine, request.maxLines, true);
        if (!sampledGroups) return { status: "unavailable", reason: "Frame rounding causes caption groups to overlap." };
        grouped = sampledGroups;
        sampledTiming = true;
        warnings.push("Caption group timing uses sampled frames rather than outward rounding and may start up to one frame after a word begins; words without sampled frames share a caption with neighboring speech. Review timing.");
      }
    }
    if (corrections.length) warnings.push("User-supplied caption corrections require review and do not alter the pinned transcript; confidence refers to the original recognition.");
    if (mapped.some((word) => Math.abs(word.sequenceRange.start - word.frameAlignedRange.start) > 1e-9 || Math.abs(word.sequenceRange.end - word.frameAlignedRange.end) > 1e-9)) warnings.push("Word timing was rounded outward to the sequence frame grid.");
    if (mapped.length === 0) warnings.push("No transcript words are available in this occurrence.");
    if (mapped.some((word) => word.confidence < 0.8)) warnings.push("Low-confidence transcript words require correction before use.");
    const groups: CaptionGroup[] = [];
    for (const words of grouped) {
      const first = words[0]!; const last = words[words.length - 1]!;
      const end = addRationalTimes(last.frameAlignedRange.startTime!, last.frameAlignedRange.durationTime!);
      const durationTime = subtractRationalTimes(end, first.frameAlignedRange.startTime!);
      const range = { start: first.frameAlignedRange.start, end: last.frameAlignedRange.end, startTime: first.frameAlignedRange.startTime!, durationTime };
      if (groups.length && groups[groups.length - 1]!.sequenceRange.end > range.start + 1e-9) return { status: "unavailable", reason: "Frame rounding causes caption groups to overlap." };
      if (words.some((word, i) => i > 0 && words[i - 1]!.frameAlignedRange.end > word.frameAlignedRange.start + 1e-9)) warnings.push("Word frame ranges overlap after rounding.");
      const lines = wrap(words, separator, request.maxCharsPerLine, request.maxLines);
      if (!lines) return { status: "unsupported", reason: "Caption lines exceed the requested format." };
      const evidenceWords = sampledTiming ? words.map((word) => mapped.find((original) => original.wordIndex === word.wordIndex)!) : words;
      groups.push({ lines, words: evidenceWords, sequenceRange: range, emphasis: words.filter((word) => selected.includes(word.wordIndex)).map((word) => ({ wordIndex: word.wordIndex, reason: "Requested for human review; not automatic styling." })) });
    }
    return { status: "available", plan: { projectId: request.projectId, timelineId: request.timelineId, occurrenceId: request.occurrenceId,
      revision: structuredClone(request.revision), analysisRef: structuredClone(ref), inputDigest: digest({ request, ref }), groups, warnings, reviewRequired: true, nativeTitleStatus: "unavailable" } };
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Error ? error.message : "Caption evidence or mapping is unavailable." };
  }
}

/** Frame starts in the exact half-open word interval, without inventing a sample. */
function sampledFrameRange(range: TimeRange, frame: { value: string; timescale: string }): TimeRange | undefined {
  if (!range.startTime || !range.durationTime) return undefined;
  const step = parseRational(frame, "ANALYSIS_INVALID");
  if (step.value <= 0n) return undefined;
  const indexAtOrAfter = (time: { value: string; timescale: string }) => {
    const value = parseRational(time, "ANALYSIS_INVALID");
    const numerator = value.value * step.timescale; const denominator = value.timescale * step.value;
    return numerator >= 0n ? (numerator + denominator - 1n) / denominator : numerator / denominator;
  };
  const start = indexAtOrAfter(range.startTime);
  const end = indexAtOrAfter(addRationalTimes(range.startTime, range.durationTime));
  if (end < start) return undefined;
  const startTime = { value: String(start * step.value), timescale: String(step.timescale) };
  const durationTime = { value: String((end - start) * step.value), timescale: String(step.timescale) };
  return { start: seconds(startTime), end: seconds(addRationalTimes(startTime, durationTime)), startTime, durationTime };
}

function sameWord(a: SpeechWord, b: SpeechWord): boolean {
  return a.text === b.text && a.start === b.start && a.end === b.end && a.confidence === b.confidence;
}
function frameSafeGroups(words: CaptionWord[], separator: string, maxWords: number, maxChars: number, maxLines: number, requireSample = false): CaptionWord[][] | undefined {
  const next = new Array<number | undefined>(words.length + 1);
  next[words.length] = words.length;
  for (let start = words.length - 1; start >= 0; start--) {
    let hasSample = false;
    for (let end = start + 1; end <= Math.min(words.length, start + maxWords); end++) {
      hasSample ||= words[end - 1]!.frameAlignedRange.end > words[end - 1]!.frameAlignedRange.start + 1e-9;
      if (!wrap(words.slice(start, end), separator, maxChars, maxLines)) break;
      if (next[end] !== undefined && (!requireSample || hasSample)
        && (end === words.length || words[end - 1]!.frameAlignedRange.end <= words[end]!.frameAlignedRange.start + 1e-9)) next[start] = end;
    }
  }
  if (next[0] === undefined) return undefined;
  const groups: CaptionWord[][] = [];
  for (let start = 0; start < words.length;) {
    const end = next[start]!;
    groups.push(words.slice(start, end));
    start = end;
  }
  return groups;
}
function wrap(words: CaptionWord[], separator: string, maxChars: number, maxLines: number): string[] | undefined {
  const lines: string[] = [];
  for (const word of words) {
    const previous = lines[lines.length - 1];
    if (previous === undefined) lines.push(word.text);
    else if (count(previous + separator + word.text) <= maxChars) lines[lines.length - 1] = previous + separator + word.text;
    else lines.push(word.text);
    if (lines.length > maxLines) return undefined;
  }
  return lines;
}
