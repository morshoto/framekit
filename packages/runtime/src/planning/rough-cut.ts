import type {
  RoughCutSpeechEvidence,
  MediaIndexEntry,
  RoughCutPlan,
  RoughCutPlanRequest,
  RoughCutShot,
  SpeechSegment,
  SpeechWord,
} from "../domain/media.js";
import type { ContextRevision } from "../domain/primitives.js";

const DEFAULT_MAX_SHOTS = 50;

export function planRoughCut(
  entries: MediaIndexEntry[],
  revision: ContextRevision,
  request: RoughCutPlanRequest,
): RoughCutPlan {
  const maxShots = request.maxShots ?? DEFAULT_MAX_SHOTS;
  if (!Number.isInteger(maxShots) || maxShots <= 0) {
    throw new Error("INVALID_ROUGH_CUT_REQUEST: maxShots must be a positive integer");
  }

  const candidates = entries
    .filter((entry) => entry.sourceIdentity.mediaKind !== "audio")
    .flatMap((entry) => candidatesForEntry(entry, request))
    .sort((left, right) => {
      if (left.queryMatches !== right.queryMatches) return right.queryMatches - left.queryMatches;
      const mediaOrder = left.entry.sourceIdentity.mediaId.localeCompare(right.entry.sourceIdentity.mediaId);
      if (mediaOrder !== 0) return mediaOrder;
      if (left.range.start !== right.range.start) return left.range.start - right.range.start;
      return left.range.end - right.range.end;
    });
  const shots = candidates.slice(0, maxShots).map(({ entry, range, evidence }, index) =>
    shotFor(entry, range, request, index + 1, evidence));
  const excludedAudioMediaIds = entries
    .filter((entry) => entry.sourceIdentity.mediaKind === "audio" && entry.semantic.usableRanges.length > 0)
    .map((entry) => entry.sourceIdentity.mediaId);
  const warnings = excludedAudioMediaIds.length > 0
    ? [`Excluded audio-only media from rough-cut shot candidates: ${excludedAudioMediaIds.join(", ")}`]
    : entries.length > 0 && candidates.length === 0
      ? ["No matching media has an explicitly analyzed usable speech or usable range"]
      : [];

  return {
    planner: { id: "framekit.rough-cut", version: 1 },
    revision: structuredClone(revision),
    query: structuredClone(request),
    shots,
    warnings,
  };
}

interface RoughCutCandidate {
  entry: MediaIndexEntry;
  range: RoughCutShot["range"];
  evidence?: RoughCutSpeechEvidence;
  queryMatches: number;
}

function candidatesForEntry(entry: MediaIndexEntry, request: RoughCutPlanRequest): RoughCutCandidate[] {
  const speechCandidates = speechCandidatesForEntry(entry, request);
  if (speechCandidates.length > 0) return speechCandidates;
  return entry.semantic.usableRanges.map((range) => ({
    entry,
    range: structuredClone(range),
    queryMatches: 0,
  }));
}

function speechCandidatesForEntry(entry: MediaIndexEntry, request: RoughCutPlanRequest): RoughCutCandidate[] {
  const speech = entry.speech;
  if (!speech) return [];
  const speechSegments = speech.vadSegments?.filter((segment) => segment.kind === "speech") ?? [];
  const ranges: Array<{ range: { start: number; end: number }; vad?: SpeechSegment }> = speechSegments.length > 0
    ? speechSegments.map((segment) => ({ range: { start: segment.start, end: segment.end }, vad: segment }))
    : wordRanges(speech.words).map((range) => ({ range }));
  return ranges.flatMap(({ range, vad }) => clipToUsableRanges(entry, range).map((clipped) => {
    const words = speech.words.filter((word) => word.end > clipped.start && word.start < clipped.end);
    const transcript = words.filter((word) => word.filler !== true).map((word) => word.text).join(" ").trim();
    const queryMatches = queryMatchCount(request.query, words);
    const averageWordConfidence = words.length === 0
      ? 0
      : words.reduce((sum, word) => sum + word.confidence, 0) / words.length;
    return {
      entry,
      range: clipped,
      queryMatches,
      evidence: {
        kind: "speech" as const,
        transcript,
        wordCount: words.length,
        averageWordConfidence,
        ...(vad ? {
          vad: {
            kind: vad.kind,
            ...(vad.confidence !== undefined ? { confidence: vad.confidence } : {}),
          },
        } : {}),
        ...(entry.audio ? {
          audio: {
            ...(Number.isFinite(entry.audio.integratedLufs) ? { integratedLufs: entry.audio.integratedLufs } : {}),
            ...(Number.isFinite(entry.audio.truePeakDb) ? { truePeakDb: entry.audio.truePeakDb } : {}),
            ...(Number.isFinite(entry.audio.silenceMs) ? { silenceMs: entry.audio.silenceMs } : {}),
          },
        } : {}),
      },
    };
  }));
}

function wordRanges(words: SpeechWord[]): Array<{ start: number; end: number }> {
  const validWords = words
    .filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const word of validWords) {
    const current = ranges[ranges.length - 1];
    if (current && word.start - current.end <= 0.8) {
      current.end = Math.max(current.end, word.end);
    } else {
      ranges.push({ start: word.start, end: word.end });
    }
  }
  return ranges;
}

function clipToUsableRanges(entry: MediaIndexEntry, range: { start: number; end: number }): Array<{ start: number; end: number }> {
  const bounds = entry.semantic.usableRanges.length > 0 ? entry.semantic.usableRanges : [range];
  const duration = entry.sourceIdentity.duration;
  return bounds.flatMap((bound) => {
    const start = Math.max(range.start, bound.start, 0);
    const end = Math.min(range.end, bound.end, duration ?? Number.POSITIVE_INFINITY);
    return end > start ? [{ start, end }] : [];
  });
}

function queryMatchCount(query: string | undefined, words: SpeechWord[]): number {
  const terms = tokenize(query);
  if (terms.length === 0) return 0;
  const transcript = words.map((word) => word.text.toLowerCase());
  return terms.filter((term) => transcript.some((word) => word.includes(term))).length;
}

function tokenize(query: string | undefined): string[] {
  return query?.trim().toLowerCase().split(/\s+/u).filter(Boolean) ?? [];
}

function shotFor(
  entry: MediaIndexEntry,
  range: RoughCutShot["range"],
  request: RoughCutPlanRequest,
  order: number,
  evidence?: RoughCutSpeechEvidence,
): RoughCutShot {
  const matchedProperties = [
    ...(request.query ? [`query:${request.query}`] : []),
    ...(request.subject ? [`subject:${request.subject}`] : []),
    ...(request.scene ? [`scene:${request.scene}`] : []),
    ...(request.environment ? [`environment:${request.environment}`] : []),
    ...(request.timeOfDay ? [`timeOfDay:${request.timeOfDay}`] : []),
    ...(request.mood ? [`mood:${request.mood}`] : []),
    ...(request.motion ? [`motion:${request.motion}`] : []),
  ];
  const semanticAnnotations = [
    { query: request.subject, tags: entry.semantic.subjects },
    { query: request.scene, tags: entry.semantic.scenes },
    { query: request.environment, tags: entry.semantic.environments },
    { query: request.timeOfDay, tags: entry.semantic.timeOfDay },
    { query: request.mood, tags: entry.semantic.moods },
  ];
  const activeAnnotations = semanticAnnotations.filter(({ query }) => Boolean(query?.trim()));
  const confidenceTags = activeAnnotations.length > 0
    ? activeAnnotations.flatMap(({ query, tags }) => tags.filter((tag) => tag.value.toLowerCase() === query!.trim().toLowerCase()))
    : semanticAnnotations.flatMap(({ tags }) => tags);
  const confidence = Math.max(0, ...confidenceTags.map((tag) => tag.confidence));
  const speechConfidence = evidence?.averageWordConfidence ?? 0;
  const combinedConfidence = evidence ? Math.max(confidence, speechConfidence) : confidence;
  const reason = matchedProperties.length > 0
    ? `matches ${matchedProperties.map((property) => {
      const [kind, ...value] = property.split(":");
      return `${kind} "${value.join(":")}"`;
    }).join(", ")}`
    : evidence
      ? `contains speech "${evidence.transcript || "(no transcript text)"}" in a VAD speech interval`
      : "has an explicitly analyzed usable range";
  const speechDetails = evidence
    ? ` Speech evidence covers ${evidence.wordCount} word${evidence.wordCount === 1 ? "" : "s"} ("${evidence.transcript || "no transcript text"}") with average confidence ${evidence.averageWordConfidence.toFixed(2)}.`
    : "";
  return {
    order,
    sourceIdentity: structuredClone(entry.sourceIdentity),
    range: structuredClone(range),
    confidence: combinedConfidence,
    matchedProperties,
    rationale: `Selected ${entry.sourceIdentity.mediaId} because it ${reason}.${speechDetails}`,
    ...(evidence ? { evidence } : {}),
  };
}
