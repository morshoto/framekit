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
  try {
    validateTimelineIr(base);
    validateTimelineIr(ours);
    validateTimelineIr(theirs);
  } catch (error) {
    return {
      status: "conflicted",
      ...common,
      conflicts: [{
        kind: /duplicate occurrence/i.test(error instanceof Error ? error.message : String(error)) ? "ambiguous-identity" : "invalid-state",
        entity: "occurrence",
        id: "unknown",
        path: "timeline",
        message: error instanceof Error ? error.message : String(error),
      }],
    };
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
