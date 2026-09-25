import type {
  MediaIndexEntry,
  RoughCutPlan,
  RoughCutPlanRequest,
  RoughCutShot,
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
    .filter((entry) => hasContentEvidence(entry.semantic))
    .flatMap((entry) => entry.semantic.usableRanges.map((range) => ({ entry, range })))
    .sort((left, right) => {
      const mediaOrder = left.entry.sourceIdentity.mediaId.localeCompare(right.entry.sourceIdentity.mediaId);
      if (mediaOrder !== 0) return mediaOrder;
      if (left.range.start !== right.range.start) return left.range.start - right.range.start;
      return left.range.end - right.range.end;
    });
  const shots = candidates.slice(0, maxShots).map(({ entry, range }, index) => shotFor(entry, range, request, index + 1));
  const excludedAudioMediaIds = entries
    .filter((entry) => entry.sourceIdentity.mediaKind === "audio" && entry.semantic.usableRanges.length > 0)
    .map((entry) => entry.sourceIdentity.mediaId);
  const warnings = excludedAudioMediaIds.length > 0
    ? [`Excluded audio-only media from rough-cut shot candidates: ${excludedAudioMediaIds.join(", ")}`]
    : entries.length > 0 && candidates.length === 0
      ? ["No matching media has content analysis for strong segment selection"]
      : [];

  return {
    planner: { id: "framekit.rough-cut", version: 1 },
    revision: structuredClone(revision),
    query: structuredClone(request),
    shots,
    warnings,
  };
}

function shotFor(
  entry: MediaIndexEntry,
  range: RoughCutShot["range"],
  request: RoughCutPlanRequest,
  order: number,
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
  const contentEvidence = contentEvidenceFor(entry.semantic, range);
  const reason = matchedProperties.length > 0
    ? `matches ${matchedProperties.map((property) => {
      const [kind, ...value] = property.split(":");
      return `${kind} "${value.join(":")}"`;
    }).join(", ")}; content evidence: ${contentEvidence.join(", ")}`
    : `has content evidence: ${contentEvidence.join(", ")}`;
  return {
    order,
    sourceIdentity: structuredClone(entry.sourceIdentity),
    range: structuredClone(range),
    confidence,
    matchedProperties,
    contentEvidence,
    reviewRequired: true,
    rationale: `Selected ${entry.sourceIdentity.mediaId} because it ${reason}. Review is required before applying a trim.`,
  };
}

function hasContentEvidence(semantic: MediaIndexEntry["semantic"]): boolean {
  return contentEvidenceFor(semantic).length > 0;
}

function contentEvidenceFor(
  semantic: MediaIndexEntry["semantic"],
  range?: RoughCutShot["range"],
): string[] {
  const evidence: string[] = [];
  for (const [kind, tags] of [
    ["subject", semantic.subjects],
    ["scene", semantic.scenes],
    ["environment", semantic.environments],
    ["timeOfDay", semantic.timeOfDay],
    ["mood", semantic.moods],
  ] as const) {
    for (const tag of tags) evidence.push(`${kind} "${tag.value}"`);
  }
  if (semantic.transcript?.trim()) {
    const words = semantic.transcript.trim().split(/\s+/).slice(0, 8).join(" ");
    evidence.push(`transcript "${words}"`);
  }
  if (semantic.motion) evidence.push(`motion ${semantic.motion.label ?? "observed"}`);
  if (semantic.audio?.present) evidence.push("audio present");
  if (range && evidence.length === 0 && semantic.usableRanges.some((candidate) => candidate.start === range.start && candidate.end === range.end)) {
    return [];
  }
  return evidence;
}
