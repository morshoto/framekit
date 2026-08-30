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
    .flatMap((entry) => entry.semantic.usableRanges.map((range) => ({ entry, range })))
    .sort((left, right) => {
      const mediaOrder = left.entry.sourceIdentity.mediaId.localeCompare(right.entry.sourceIdentity.mediaId);
      if (mediaOrder !== 0) return mediaOrder;
      if (left.range.start !== right.range.start) return left.range.start - right.range.start;
      return left.range.end - right.range.end;
    });
  const shots = candidates.slice(0, maxShots).map(({ entry, range }, index) => shotFor(entry, range, request, index + 1));
  const warnings = entries.length > 0 && candidates.length === 0
    ? ["No matching media has an explicitly analyzed usable range"]
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
  const confidence = Math.max(
    0,
    ...entry.semantic.subjects.map((tag) => tag.confidence),
    ...entry.semantic.scenes.map((tag) => tag.confidence),
    ...entry.semantic.environments.map((tag) => tag.confidence),
    ...entry.semantic.timeOfDay.map((tag) => tag.confidence),
    ...entry.semantic.moods.map((tag) => tag.confidence),
  );
  const reason = matchedProperties.length > 0
    ? `matches ${matchedProperties.map((property) => {
      const [kind, ...value] = property.split(":");
      return `${kind} "${value.join(":")}"`;
    }).join(", ")}`
    : "has an explicitly analyzed usable range";
  return {
    order,
    sourceIdentity: structuredClone(entry.sourceIdentity),
    range: structuredClone(range),
    confidence,
    matchedProperties,
    rationale: `Selected ${entry.sourceIdentity.mediaId} because it ${reason}.`,
  };
}
