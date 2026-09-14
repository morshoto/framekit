import { createHash } from "node:crypto";
import type { TimelineIr, TimelineIrCaption, TimelineIrMarker, TimelineIrOccurrence, TimelineIrResource, TimelineIrStoryElement } from "./editing-session.js";
import type { ContextRevision } from "../domain/primitives.js";
import { validateTimelineIr } from "./editing-session.js";

export type TimelineReconciliationEntity = "project" | "sequence" | "resource" | "occurrence" | "story-element" | "marker" | "caption";
export type TimelineReconciliationConflictKind = "property-conflict" | "delete-modify-conflict" | "insert-conflict" | "ambiguous-identity" | "invalid-state";

export interface TimelineReconciliationConflict {
  kind: TimelineReconciliationConflictKind;
  entity: TimelineReconciliationEntity;
  id: string;
  path: string;
  baseValue?: unknown;
  oursValue?: unknown;
  theirsValue?: unknown;
  message: string;
}

export interface TimelineReconciliationInput {
  base: TimelineIr;
  ours: TimelineIr;
  theirs: TimelineIr;
}

export type TimelineReconciliationResult =
  | {
      status: "rebased";
      providerRevisionChanged: boolean;
      baseRevision: ContextRevision;
      oursRevision: ContextRevision;
      theirsRevision: ContextRevision;
      merged: TimelineIr;
      conflicts: [];
    }
  | {
      status: "conflicted";
      providerRevisionChanged: boolean;
      baseRevision: ContextRevision;
      oursRevision: ContextRevision;
      theirsRevision: ContextRevision;
      merged?: undefined;
      conflicts: TimelineReconciliationConflict[];
    };

type TimelineEntity =
  | TimelineIrResource
  | TimelineIrOccurrence
  | TimelineIrStoryElement
  | TimelineIrMarker
  | TimelineIrCaption;
type JsonRecord = Record<string, unknown>;
type TimelineValidationSource = "base" | "ours" | "theirs" | "merged";

/**
 * Three-way merge for the provider-neutral timeline. BASE is never written;
 * OURS is the agent's desired state and THEIRS is the latest provider state.
 */
export function reconcileTimelineIr(input: TimelineReconciliationInput): TimelineReconciliationResult {
  const { base, ours, theirs } = input;
  const providerRevisionChanged = !sameRevision(base.revision, theirs.revision);
  const common = {
    providerRevisionChanged,
    baseRevision: structuredClone(base.revision),
    oursRevision: structuredClone(ours.revision),
    theirsRevision: structuredClone(theirs.revision),
  };
  for (const [source, timeline] of [["base", base], ["ours", ours], ["theirs", theirs]] as const) {
    try {
      validateTimelineIr(timeline);
    } catch (error) {
      return { status: "conflicted", ...common, conflicts: [validationConflict(source, timeline, error)] };
    }
  }
  const conflicts: TimelineReconciliationConflict[] = [];
  if (base.project.id !== ours.project.id || base.project.id !== theirs.project.id
    || base.sequence.id !== ours.sequence.id || base.sequence.id !== theirs.sequence.id) {
    conflicts.push({
      kind: "ambiguous-identity",
      entity: "sequence",
      id: base.sequence.id,
      path: "project/sequence",
      baseValue: `${base.project.id}/${base.sequence.id}`,
      oursValue: `${ours.project.id}/${ours.sequence.id}`,
      theirsValue: `${theirs.project.id}/${theirs.sequence.id}`,
      message: "BASE, OURS, and THEIRS do not address the same project and sequence",
    });
    return { status: "conflicted", ...common, conflicts };
  }

  const project = mergeRecord("project", "project", "project", base.project, ours.project, theirs.project, conflicts);
  const baseSequence = sequenceMetadata(base);
  const oursSequence = sequenceMetadata(ours);
  const theirsSequence = sequenceMetadata(theirs);
  const sequence = mergeRecord("sequence", base.sequence.id, "sequence", baseSequence, oursSequence, theirsSequence, conflicts);
  const resources = mergeCollection("resource", "resources", base.resources, ours.resources, theirs.resources, conflicts);
  const occurrences = mergeCollection("occurrence", "sequence.occurrences", base.sequence.occurrences, ours.sequence.occurrences, theirs.sequence.occurrences, conflicts);
  const storyElements = mergeCollection("story-element", "sequence.storyElements", base.sequence.storyElements, ours.sequence.storyElements, theirs.sequence.storyElements, conflicts);
  const markers = mergeCollection("marker", "sequence.markers", base.sequence.markers, ours.sequence.markers, theirs.sequence.markers, conflicts);
  const captions = mergeCollection("caption", "sequence.captions", base.sequence.captions, ours.sequence.captions, theirs.sequence.captions, conflicts);
  if (conflicts.length > 0 || !project || !sequence) return { status: "conflicted", ...common, conflicts };

  const merged: TimelineIr = {
    schemaVersion: 1,
    project: project as TimelineIr["project"],
    sequence: {
      ...(sequence as Omit<TimelineIr["sequence"], "occurrences" | "storyElements" | "markers" | "captions">),
      occurrences: occurrences as TimelineIrOccurrence[],
      storyElements: storyElements as TimelineIrStoryElement[],
      markers: markers as TimelineIrMarker[],
      captions: captions as TimelineIrCaption[],
    },
    resources: resources as TimelineIrResource[],
    revision: structuredClone(theirs.revision),
  };
  validateTimelineIr(merged);
  return { status: "rebased", ...common, merged, conflicts: [] };
}

function sequenceMetadata(timeline: TimelineIr): Omit<TimelineIr["sequence"], "occurrences" | "storyElements" | "markers" | "captions"> {
  const { occurrences: _occurrences, storyElements: _storyElements, markers: _markers, captions: _captions, ...metadata } = timeline.sequence;
  return metadata;
}

function mergeCollection<T extends TimelineEntity>(
  entity: TimelineReconciliationEntity,
  path: string,
  base: T[],
  ours: T[],
  theirs: T[],
  conflicts: TimelineReconciliationConflict[],
): T[] | undefined {
  const baseMap = uniqueEntityMap(entity, base, conflicts);
  const oursMap = uniqueEntityMap(entity, ours, conflicts);
  const theirsMap = uniqueEntityMap(entity, theirs, conflicts);
  if (!baseMap || !oursMap || !theirsMap) return undefined;
  const ids = [...new Set([
    ...base.map(({ id }) => id),
    ...[...oursMap.keys()].filter((id) => !baseMap.has(id)),
    ...[...theirsMap.keys()].filter((id) => !baseMap.has(id)),
  ])];
  const additions = ids.filter((id) => !baseMap.has(id)).sort((left, right) => left.localeCompare(right));
  const orderedIds = [...base.map(({ id }) => id), ...additions];
  const merged: T[] = [];
  for (const id of orderedIds) {
    const value = mergeEntity(entity, `${path}[${id}]`, id, baseMap.get(id), oursMap.get(id), theirsMap.get(id), conflicts);
    if (value) merged.push(value as T);
  }
  return merged;
}

function mergeEntity(
  entity: TimelineReconciliationEntity,
  path: string,
  id: string,
  base: TimelineEntity | undefined,
  ours: TimelineEntity | undefined,
  theirs: TimelineEntity | undefined,
  conflicts: TimelineReconciliationConflict[],
): TimelineEntity | undefined {
  if (!base) {
    if (!ours) return structuredClone(theirs);
    if (!theirs) return structuredClone(ours);
    if (deepEqual(ours, theirs)) return structuredClone(ours);
    conflicts.push({ kind: "insert-conflict", entity, id, path, oursValue: ours, theirsValue: theirs, message: `both sides inserted different values for ${entity} ${id}` });
    return undefined;
  }
  if (!ours && !theirs) return undefined;
  if (!ours) {
    if (deepEqual(theirs, base)) return undefined;
    conflicts.push({ kind: "delete-modify-conflict", entity, id, path, baseValue: base, theirsValue: theirs, message: `agent deleted ${entity} ${id} while provider modified it` });
    return undefined;
  }
  if (!theirs) {
    if (deepEqual(ours, base)) return undefined;
    conflicts.push({ kind: "delete-modify-conflict", entity, id, path, baseValue: base, oursValue: ours, message: `provider deleted ${entity} ${id} while agent modified it` });
    return undefined;
  }
  return mergeRecord(entity, id, path, base as unknown as JsonRecord, ours as unknown as JsonRecord, theirs as unknown as JsonRecord, conflicts) as unknown as TimelineEntity;
}

function mergeRecord(
  entity: TimelineReconciliationEntity,
  id: string,
  path: string,
  base: JsonRecord,
  ours: JsonRecord,
  theirs: JsonRecord,
  conflicts: TimelineReconciliationConflict[],
): JsonRecord | undefined {
  const merged: JsonRecord = {};
  for (const key of [...new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])].sort()) {
    const value = mergeValue(entity, id, `${path}.${key}`, base[key], ours[key], theirs[key], conflicts);
    if (value !== undefined) merged[key] = value;
  }
  return conflicts.some((conflict) => conflict.id === id && conflict.path.startsWith(path)) ? undefined : merged;
}

function mergeValue(
  entity: TimelineReconciliationEntity,
  id: string,
  path: string,
  base: unknown,
  ours: unknown,
  theirs: unknown,
  conflicts: TimelineReconciliationConflict[],
): unknown {
  if (deepEqual(ours, base)) return structuredClone(theirs);
  if (deepEqual(theirs, base)) return structuredClone(ours);
  if (deepEqual(ours, theirs)) return structuredClone(ours);
  if (isRecord(base) && isRecord(ours) && isRecord(theirs)) return mergeRecord(entity, id, path, base, ours, theirs, conflicts);
  conflicts.push({ kind: "property-conflict", entity, id, path, baseValue: base, oursValue: ours, theirsValue: theirs, message: `both sides changed ${path}` });
  return undefined;
}

function uniqueEntityMap<T extends TimelineEntity>(
  entity: TimelineReconciliationEntity,
  values: T[],
  conflicts: TimelineReconciliationConflict[],
): Map<string, T> | undefined {
  const result = new Map<string, T>();
  for (const value of values) {
    if (result.has(value.id)) {
      conflicts.push({ kind: "ambiguous-identity", entity, id: value.id, path: entity, message: `duplicate ${entity} identity ${value.id}` });
      return undefined;
    }
    result.set(value.id, value);
  }
  return result;
}

function sameRevision(left: ContextRevision, right: ContextRevision): boolean {
  return left.id === right.id && left.sequence === right.sequence;
}

function validationConflict(source: TimelineValidationSource, timeline: TimelineIr, error: unknown): TimelineReconciliationConflict {
  const message = error instanceof Error ? error.message : String(error);
  const detail = message.replace(/^TIMELINE_IR_INVALID:\s*/, "");
  const duplicate = detail.match(/^duplicate (resource|occurrence|story element|marker|caption) id (.+)$/i);
  if (duplicate) {
    const entity = entityForLabel(duplicate[1]!);
    return {
      kind: "ambiguous-identity",
      entity,
      id: duplicate[2]!,
      path: collectionPath(entity),
      message: `${source} timeline validation failed: ${detail}`,
    };
  }

  const location = validationLocation(detail, timeline);
  return {
    kind: "invalid-state",
    ...location,
    message: `${source} timeline validation failed: ${detail}`,
  };
}

function validationLocation(detail: string, timeline: TimelineIr): Pick<TimelineReconciliationConflict, "entity" | "id" | "path"> {
  const topLevelField = detail.match(/^(project|sequence)\.(.+)$/);
  if (topLevelField) {
    const entity = entityForLabel(topLevelField[1]!);
    return { entity, id: timelineEntityId(timeline, entity), path: topLevelField[0]! };
  }
  if (detail === "project is required") return { entity: "project", id: "unknown", path: "project" };
  if (detail === "sequence is required") return { entity: "sequence", id: "unknown", path: "sequence" };

  const entityField = detail.match(/^(resource|occurrence|story element|marker|caption) (.+)\.([^. ]+)(?: .*)?$/);
  if (entityField) {
    const entity = entityForLabel(entityField[1]!);
    return { entity, id: entityField[2]!, path: `${collectionPath(entity)}[${entityField[2]}].${entityField[3]}` };
  }
  const unsupportedMediaKind = detail.match(/^resource (.+) has unsupported mediaKind$/);
  if (unsupportedMediaKind) return { entity: "resource", id: unsupportedMediaKind[1]!, path: `resources[${unsupportedMediaKind[1]}].mediaKind` };
  const occurrenceReference = detail.match(/^occurrence (.+) references unknown (resource|attachment)(?: .+)?$/);
  if (occurrenceReference) {
    const field = occurrenceReference[2] === "resource" ? "mediaId" : "attachedTo";
    return { entity: "occurrence", id: occurrenceReference[1]!, path: `sequence.occurrences[${occurrenceReference[1]}].${field}` };
  }
  const storyReference = detail.match(/^story element (.+) references unknown occurrence$/);
  if (storyReference) return { entity: "story-element", id: storyReference[1]!, path: `sequence.storyElements[${storyReference[1]}].occurrenceId` };

  const collection = detail.match(/^(resources|occurrences|storyElements|markers|captions) must be an array$/);
  if (collection) {
    const entity = entityForCollection(collection[1]!);
    return { entity, id: "unknown", path: collection[1]! };
  }
  if (detail.startsWith("revision.")) return { entity: "sequence", id: timelineEntityId(timeline, "sequence"), path: detail };
  return { entity: "sequence", id: timelineEntityId(timeline, "sequence"), path: "timeline" };
}

function entityForLabel(label: string): TimelineReconciliationEntity {
  return label === "story element" ? "story-element" : label as TimelineReconciliationEntity;
}

function entityForCollection(collection: string): TimelineReconciliationEntity {
  switch (collection) {
    case "resources": return "resource";
    case "occurrences": return "occurrence";
    case "storyElements": return "story-element";
    case "markers": return "marker";
    case "captions": return "caption";
    default: return "sequence";
  }
}

function collectionPath(entity: TimelineReconciliationEntity): string {
  switch (entity) {
    case "resource": return "resources";
    case "occurrence": return "sequence.occurrences";
    case "story-element": return "sequence.storyElements";
    case "marker": return "sequence.markers";
    case "caption": return "sequence.captions";
    case "project": return "project";
    case "sequence": return "sequence";
  }
}

function timelineEntityId(timeline: TimelineIr, entity: TimelineReconciliationEntity): string {
  if (entity === "project") return typeof timeline?.project?.id === "string" ? timeline.project.id : "unknown";
  return typeof timeline?.sequence?.id === "string" ? timeline.sequence.id : "unknown";
}

function deepEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value).filter(([, child]) => child !== undefined).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
}

export function timelineIrContentDigest(timeline: TimelineIr): string {
  const content = structuredClone(timeline);
  delete (content as Partial<TimelineIr>).revision;
  return createHash("sha256").update(stableJson(content)).digest("hex");
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
