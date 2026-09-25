import { createHash } from "node:crypto";
import type { ContextRevision, RationalTime } from "../domain/primitives.js";
import type { MediaContext } from "../domain/media.js";
import type { ProjectSnapshot, StoryElement } from "../domain/project.js";
import { addRationalTimes } from "./rational-time.js";
import { parseRational } from "./rational-time.js";
import { reconcileTimelineIr, type TimelineReconciliationResult } from "./drift-reconciliation.js";

export const TIMELINE_IR_SCHEMA_VERSION = 1 as const;

export type TimelineIrRole = "video" | "audio" | "music" | "title";
export type TimelineIrResourceKind = "video" | "audio" | "unknown";
export type TimelineIrBindingKind = "project" | "sequence" | "resource" | "occurrence" | "story-element";

/** Provider identity is kept at the edge of the IR, not in core timeline fields. */
export interface TimelineIrBinding {
  provider: string;
  kind: TimelineIrBindingKind;
  identity: string;
}

export interface TimelineIrProvider {
  id: string;
  version?: string;
}

export interface TimelineIrResource {
  id: string;
  name: string;
  mediaKind: TimelineIrResourceKind;
  source?: string;
  sourceDigest?: string;
  binding?: TimelineIrBinding;
}

export interface TimelineIrOccurrence {
  id: string;
  name: string;
  startTime: RationalTime;
  durationTime: RationalTime;
  sourceStartTime?: RationalTime;
  track: number;
  role?: TimelineIrRole;
  mediaId?: string;
  gainDb?: number;
  fadeIn?: number;
  fadeOut?: number;
  enabled?: boolean;
  attachedTo?: string;
  binding?: TimelineIrBinding;
}

export interface TimelineIrStoryElement {
  id: string;
  kind: string;
  startTime: RationalTime;
  durationTime: RationalTime;
  lane?: number;
  occurrenceId?: string;
  text?: string;
  attachedTo?: string;
  binding?: TimelineIrBinding;
}

export interface TimelineIrMarker {
  id: string;
  name: string;
  startTime: RationalTime;
  durationTime: RationalTime;
}

export interface TimelineIrCaption {
  id: string;
  text: string;
  startTime: RationalTime;
  durationTime: RationalTime;
}

export interface TimelineIr {
  schemaVersion: typeof TIMELINE_IR_SCHEMA_VERSION;
  project: {
    id: string;
    name: string;
    binding?: TimelineIrBinding;
  };
  sequence: {
    id: string;
    name: string;
    durationTime: RationalTime;
    frameDuration: RationalTime;
    occurrences: TimelineIrOccurrence[];
    storyElements: TimelineIrStoryElement[];
    markers: TimelineIrMarker[];
    captions: TimelineIrCaption[];
    binding?: TimelineIrBinding;
  };
  resources: TimelineIrResource[];
  revision: ContextRevision;
}

export type TimelineIrEditOperation =
  | { type: "rename-occurrence"; occurrenceId: string; name: string }
  | { type: "trim-occurrence"; occurrenceId: string; durationTime: RationalTime }
  | { type: "move-occurrence"; occurrenceId: string; startTime: RationalTime; track?: number }
  | { type: "set-gain"; occurrenceId: string; gainDb: number }
  | { type: "remove-occurrence"; occurrenceId: string }
  | { type: "add-marker"; marker: TimelineIrMarker };

export type EditingSessionState =
  | "clean"
  | "dirty"
  | "possibly_stale"
  | "conflicted"
  | "rebased"
  | "waiting_for_materialization";

export interface EditingSessionDocument {
  schemaVersion: typeof TIMELINE_IR_SCHEMA_VERSION;
  provider?: TimelineIrProvider;
  base: TimelineIr;
  desired: TimelineIr;
  state: EditingSessionState;
  observation?: EditingSessionObservation;
}

export interface EditingSessionObservation {
  backend: string;
  sourceId: string;
  databaseKind: string;
  digest: string;
  schemaVersion: number;
  observedAt: string;
  canonical: false;
  coverageComplete: false;
}

export interface EditingSessionCreateOptions {
  base: TimelineIr;
  provider?: TimelineIrProvider;
  clock?: () => string;
}

export interface TimelineIrPreview {
  baseRevision: ContextRevision;
  before: TimelineIr;
  after: TimelineIr;
  operations: TimelineIrEditOperation[];
  changedOccurrenceIds: string[];
  changedMarkerIds: string[];
  state: EditingSessionState;
}

export interface EditingSessionApplyResult extends TimelineIrPreview {
  state: "dirty" | "possibly_stale" | "conflicted" | "rebased" | "waiting_for_materialization" | "clean";
}

export class EditingSession {
  private readonly value: EditingSessionDocument;
  private readonly clock: () => string;

  private constructor(document: EditingSessionDocument, clock?: () => string) {
    validateEditingSessionDocument(document);
    this.value = structuredClone(document);
    this.clock = clock ?? (() => new Date().toISOString());
  }

  public static create(options: EditingSessionCreateOptions): EditingSession {
    validateTimelineIr(options.base);
    const base = structuredClone(options.base);
    return new EditingSession({
      schemaVersion: TIMELINE_IR_SCHEMA_VERSION,
      ...(options.provider ? { provider: { ...options.provider } } : {}),
      base,
      desired: structuredClone(base),
      state: "clean",
    }, options.clock);
  }

  public static fromJSON(input: string | unknown, clock?: () => string): EditingSession {
    let value: unknown;
    try {
      value = typeof input === "string" ? JSON.parse(input) : input;
    } catch (error) {
      throw new Error(`TIMELINE_IR_INVALID: session JSON is malformed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const document = asRecord(value);
    if (!document) throw new Error("TIMELINE_IR_INVALID: session must be an object");
    validateEditingSessionDocument(document as unknown as EditingSessionDocument);
    return new EditingSession(document as unknown as EditingSessionDocument, clock);
  }

  public document(): EditingSessionDocument {
    return structuredClone(this.value);
  }

  public base(): TimelineIr {
    return structuredClone(this.value.base);
  }

  public desired(): TimelineIr {
    return structuredClone(this.value.desired);
  }

  public state(): EditingSessionState {
    return this.value.state;
  }

  public serialize(): string {
    return stableJson(this.value);
  }

  public observeProviderRevision(providerRevision: ContextRevision): "unchanged" | "changed" {
    if (sameRevision(this.value.base.revision, providerRevision)) return "unchanged";
    if (this.value.state !== "conflicted") this.value.state = "possibly_stale";
    return "changed";
  }

  public preview(
    operations: TimelineIrEditOperation[],
    expectedRevision: ContextRevision = this.value.desired.revision,
  ): TimelineIrPreview {
    this.assertEditable();
    assertRevision(this.value.desired.revision, expectedRevision);
    const before = structuredClone(this.value.desired);
    const after = this.nextTimeline(before, operations);
    const changed = changedIds(before, after);
    return {
      baseRevision: this.value.base.revision,
      before,
      after,
      operations: structuredClone(operations),
      ...changed,
      state: changedOccurrenceOrMarkers(changed) ? editState(this.value.state) : this.value.state,
    };
  }

  public apply(
    operations: TimelineIrEditOperation[],
    expectedRevision: ContextRevision = this.value.desired.revision,
  ): EditingSessionApplyResult {
    const preview = this.preview(operations, expectedRevision);
    this.value.desired = preview.after;
    if (changedOccurrenceOrMarkers(preview)) {
      this.value.desired.revision = nextRevision(preview.after, this.value.desired.revision, this.clock());
      this.value.state = editState(this.value.state);
      preview.after = structuredClone(this.value.desired);
      preview.state = this.value.state;
    }
    return {
      ...preview,
      state: this.value.state,
    };
  }

  public assertMaterializationReady(providerRevision: ContextRevision): void {
    if (!sameRevision(this.value.base.revision, providerRevision)) {
      this.value.state = "possibly_stale";
      throw new Error("RECONCILIATION_REQUIRED: provider revision changed before materialization");
    }
    if (this.value.state === "possibly_stale" || this.value.state === "conflicted") {
      throw new Error("RECONCILIATION_REQUIRED: session must be reconciled before materialization");
    }
  }

  public reconcile(providerState: TimelineIr): TimelineReconciliationResult {
    if (!sameRevision(this.value.base.revision, providerState.revision)) this.value.state = "possibly_stale";
    const result = reconcileTimelineIr({ base: this.value.base, ours: this.value.desired, theirs: providerState });
    if (result.status === "conflicted") {
      this.value.state = "conflicted";
      return result;
    }
    this.value.base = structuredClone(providerState);
    this.value.desired = structuredClone(result.merged);
    if (timelineIrDigest(this.value.desired) !== timelineIrDigest(this.value.base)) {
      const previous = this.value.desired.revision.sequence >= providerState.revision.sequence
        ? this.value.desired.revision
        : providerState.revision;
      this.value.desired.revision = nextRevision(this.value.desired, previous, this.clock());
    } else {
      this.value.desired = structuredClone(providerState);
    }
    this.value.state = "rebased";
    return result;
  }

  public markPossiblyStale(): void {
    this.value.state = "possibly_stale";
  }

  public bindObservation(observation: EditingSessionObservation): "observed" | "unchanged" | "changed" {
    const previous = this.value.observation;
    if (previous && previous.sourceId !== observation.sourceId) {
      throw new Error("SESSION_OBSERVATION_SOURCE_MISMATCH: observation source changed");
    }
    this.value.observation = structuredClone(observation);
    if (!previous) return "observed";
    if (previous.digest === observation.digest && previous.schemaVersion === observation.schemaVersion) return "unchanged";
    this.value.state = "possibly_stale";
    return "changed";
  }

  public markConflicted(): void {
    this.value.state = "conflicted";
  }

  public markRebased(): void {
    this.value.state = "rebased";
  }

  public markWaitingForMaterialization(): void {
    this.value.state = "waiting_for_materialization";
  }

  public markClean(): void {
    this.value.state = timelineIrDigest(this.value.base) === timelineIrDigest(this.value.desired) ? "clean" : "dirty";
  }

  private nextTimeline(before: TimelineIr, operations: TimelineIrEditOperation[]): TimelineIr {
    const after = structuredClone(before);
    for (const operation of operations) applyOperation(after, operation);
    validateTimelineIr(after);
    return after;
  }

  private assertEditable(): void {
    if (this.value.state === "possibly_stale" || this.value.state === "conflicted") {
      throw new Error("RECONCILIATION_REQUIRED: session must be reconciled before editing");
    }
  }
}

export function createTimelineIrFromProjectSnapshot(
  snapshot: ProjectSnapshot,
  provider?: TimelineIrProvider,
): TimelineIr {
  const binding = provider ? (kind: TimelineIrBindingKind, identity: string): TimelineIrBinding => ({
    provider: provider.id,
    kind,
    identity,
  }) : undefined;
  const resources = snapshot.media.map((media) => ({
    id: media.mediaId,
    name: sourceName(media.source, media.mediaId),
    mediaKind: media.mediaKind ?? "unknown",
    source: media.source,
    ...(media.sourceDigest ? { sourceDigest: media.sourceDigest } : {}),
    ...(binding ? { binding: binding("resource", media.mediaId) } : {}),
  } satisfies TimelineIrResource));
  const occurrences = snapshot.timeline.clips.map((clip) => ({
    id: clip.id,
    name: clip.name,
    startTime: normalizeRationalTime(clip.startTime),
    durationTime: normalizeRationalTime(clip.durationTime),
    ...(clip.sourceStartTime ? { sourceStartTime: normalizeRationalTime(clip.sourceStartTime) } : {}),
    track: clip.track,
    ...(clip.role ? { role: clip.role } : {}),
    ...(clip.mediaId ? { mediaId: clip.mediaId } : {}),
    ...(clip.gainDb !== undefined ? { gainDb: clip.gainDb } : {}),
    ...(clip.fadeIn !== undefined ? { fadeIn: clip.fadeIn } : {}),
    ...(clip.fadeOut !== undefined ? { fadeOut: clip.fadeOut } : {}),
    ...(clip.enabled !== undefined ? { enabled: clip.enabled } : {}),
    ...(clip.attachedTo ? { attachedTo: clip.attachedTo } : {}),
    ...(binding ? { binding: binding("occurrence", clip.id) } : {}),
  } satisfies TimelineIrOccurrence));
  const storyElements = snapshot.timeline.storyElements.map((element) => storyElementToIr(element, binding));
  const markers = snapshot.timeline.markers.map((marker) => ({
    id: marker.id,
    name: marker.name,
    startTime: requiredRational(marker.startTime, `marker ${marker.id} startTime`),
    durationTime: requiredRational(marker.durationTime, `marker ${marker.id} durationTime`),
  }));
  const captions = snapshot.timeline.captions.map((caption) => ({
    id: caption.id,
    text: caption.text,
    startTime: requiredRational(caption.startTime, `caption ${caption.id} startTime`),
    durationTime: requiredRational(caption.durationTime, `caption ${caption.id} durationTime`),
  }));
  return {
    schemaVersion: TIMELINE_IR_SCHEMA_VERSION,
    project: {
      id: snapshot.projectId,
      name: snapshot.projectName,
      ...(binding ? { binding: binding("project", snapshot.projectId) } : {}),
    },
    sequence: {
      id: snapshot.timeline.id,
      name: snapshot.timeline.name,
      durationTime: requiredRational(snapshot.timeline.durationTime, "timeline durationTime"),
      frameDuration: requiredRational(snapshot.timeline.frameDuration, "timeline frameDuration"),
      occurrences,
      storyElements,
      markers,
      captions,
      ...(binding ? { binding: binding("sequence", snapshot.timeline.id) } : {}),
    },
    resources,
    revision: structuredClone(snapshot.revision),
  };
}

export function validateTimelineIr(timeline: TimelineIr): void {
  if (!timeline || typeof timeline !== "object" || timeline.schemaVersion !== TIMELINE_IR_SCHEMA_VERSION) {
    throw new Error("TIMELINE_IR_INVALID: schemaVersion must be 1");
  }
  if (!timeline.project || typeof timeline.project !== "object") throw new Error("TIMELINE_IR_INVALID: project is required");
  if (!timeline.sequence || typeof timeline.sequence !== "object") throw new Error("TIMELINE_IR_INVALID: sequence is required");
  if (!Array.isArray(timeline.resources)) throw new Error("TIMELINE_IR_INVALID: resources must be an array");
  if (!Array.isArray(timeline.sequence.occurrences)) throw new Error("TIMELINE_IR_INVALID: occurrences must be an array");
  if (!Array.isArray(timeline.sequence.storyElements)) throw new Error("TIMELINE_IR_INVALID: storyElements must be an array");
  if (!Array.isArray(timeline.sequence.markers)) throw new Error("TIMELINE_IR_INVALID: markers must be an array");
  if (!Array.isArray(timeline.sequence.captions)) throw new Error("TIMELINE_IR_INVALID: captions must be an array");
  requireText(timeline.project?.id, "project.id");
  requireText(timeline.project?.name, "project.name");
  requireText(timeline.sequence?.id, "sequence.id");
  requireText(timeline.sequence?.name, "sequence.name");
  validateRational(timeline.sequence.durationTime, "sequence.durationTime", false);
  validateRational(timeline.sequence.frameDuration, "sequence.frameDuration", true);
  validateRevision(timeline.revision);
  validateBinding(timeline.project.binding, "project.binding");
  validateBinding(timeline.sequence.binding, "sequence.binding");

  const resourceIds = uniqueIds(timeline.resources.map((resource) => resource.id), "resource");
  for (const resource of timeline.resources) {
    requireText(resource.name, `resource ${resource.id}.name`);
    if (!["video", "audio", "unknown"].includes(resource.mediaKind)) {
      throw new Error(`TIMELINE_IR_INVALID: resource ${resource.id} has unsupported mediaKind`);
    }
    validateBinding(resource.binding, `resource ${resource.id}.binding`);
  }
  const occurrenceIds = uniqueIds(timeline.sequence.occurrences.map((occurrence) => occurrence.id), "occurrence");
  for (const occurrence of timeline.sequence.occurrences) {
    requireText(occurrence.name, `occurrence ${occurrence.id}.name`);
    validateRational(occurrence.startTime, `occurrence ${occurrence.id}.startTime`, false);
    validateRational(occurrence.durationTime, `occurrence ${occurrence.id}.durationTime`, true);
    if (!Number.isInteger(occurrence.track) || occurrence.track < 0) {
      throw new Error(`TIMELINE_IR_INVALID: occurrence ${occurrence.id}.track must be a non-negative integer`);
    }
    if (occurrence.mediaId && !resourceIds.has(occurrence.mediaId)) {
      throw new Error(`TIMELINE_IR_INVALID: occurrence ${occurrence.id} references unknown resource ${occurrence.mediaId}`);
    }
    if (occurrence.attachedTo && !occurrenceIds.has(occurrence.attachedTo)) {
      throw new Error(`TIMELINE_IR_INVALID: occurrence ${occurrence.id} references unknown attachment ${occurrence.attachedTo}`);
    }
    if (occurrence.sourceStartTime) validateRational(occurrence.sourceStartTime, `occurrence ${occurrence.id}.sourceStartTime`, false);
    if (occurrence.gainDb !== undefined && !Number.isFinite(occurrence.gainDb)) throw new Error(`TIMELINE_IR_INVALID: occurrence ${occurrence.id}.gainDb must be finite`);
    validateBinding(occurrence.binding, `occurrence ${occurrence.id}.binding`);
  }
  uniqueIds(timeline.sequence.storyElements.map((element) => element.id), "story element");
  for (const element of timeline.sequence.storyElements) {
    requireText(element.kind, `story element ${element.id}.kind`);
    validateRational(element.startTime, `story element ${element.id}.startTime`, false);
    validateRational(element.durationTime, `story element ${element.id}.durationTime`, true);
    if (element.occurrenceId && !occurrenceIds.has(element.occurrenceId)) throw new Error(`TIMELINE_IR_INVALID: story element ${element.id} references unknown occurrence`);
    validateBinding(element.binding, `story element ${element.id}.binding`);
  }
  uniqueIds(timeline.sequence.markers.map((marker) => marker.id), "marker");
  for (const marker of timeline.sequence.markers) {
    requireText(marker.name, `marker ${marker.id}.name`);
    validateRational(marker.startTime, `marker ${marker.id}.startTime`, false);
    validateRational(marker.durationTime, `marker ${marker.id}.durationTime`, false);
  }
  uniqueIds(timeline.sequence.captions.map((caption) => caption.id), "caption");
  for (const caption of timeline.sequence.captions) {
    requireText(caption.text, `caption ${caption.id}.text`);
    validateRational(caption.startTime, `caption ${caption.id}.startTime`, false);
    validateRational(caption.durationTime, `caption ${caption.id}.durationTime`, false);
  }
}

export function validateEditingSessionDocument(document: EditingSessionDocument): void {
  if (!document || typeof document !== "object" || document.schemaVersion !== TIMELINE_IR_SCHEMA_VERSION) {
    throw new Error("TIMELINE_IR_INVALID: session schemaVersion must be 1");
  }
  if (document.provider) {
    requireText(document.provider.id, "provider.id");
    if (document.provider.version !== undefined) requireText(document.provider.version, "provider.version");
  }
  validateTimelineIr(document.base);
  validateTimelineIr(document.desired);
  if (document.base.project.id !== document.desired.project.id || document.base.sequence.id !== document.desired.sequence.id) {
    throw new Error("TIMELINE_IR_INVALID: base and desired targets must match");
  }
  if (!["clean", "dirty", "possibly_stale", "conflicted", "rebased", "waiting_for_materialization"].includes(document.state)) {
    throw new Error("TIMELINE_IR_INVALID: unsupported session state");
  }
  if (document.observation) validateEditingSessionObservation(document.observation);
}

function validateEditingSessionObservation(observation: EditingSessionObservation): void {
  if (!observation.backend || !observation.sourceId || !observation.databaseKind || !observation.digest) {
    throw new Error("TIMELINE_IR_INVALID: session observation identity is incomplete");
  }
  if (!Number.isInteger(observation.schemaVersion) || observation.schemaVersion < 0) {
    throw new Error("TIMELINE_IR_INVALID: session observation schemaVersion must be non-negative");
  }
  if (observation.canonical !== false || observation.coverageComplete !== false) {
    throw new Error("TIMELINE_IR_INVALID: storage observation cannot be canonical or complete");
  }
}

export function timelineIrDigest(timeline: TimelineIr): string {
  const content = structuredClone(timeline);
  delete (content as Partial<TimelineIr>).revision;
  return createHash("sha256").update(stableJson(content)).digest("hex");
}

function applyOperation(timeline: TimelineIr, operation: TimelineIrEditOperation): void {
  const occurrence = operation.type === "add-marker" ? undefined : timeline.sequence.occurrences.find(({ id }) => id === operation.occurrenceId);
  if (operation.type !== "add-marker" && !occurrence) throw new Error(`TIMELINE_IR_OPERATION_INVALID: occurrence not found: ${operation.occurrenceId}`);
  switch (operation.type) {
    case "rename-occurrence":
      requireText(operation.name, "operation.name");
      occurrence!.name = operation.name;
      return;
    case "trim-occurrence":
      occurrence!.durationTime = normalizeRationalTime(operation.durationTime);
      validateRational(occurrence!.durationTime, "operation.durationTime", true);
      timeline.sequence.durationTime = maxRational(timeline.sequence.durationTime, addRationalTimes(occurrence!.startTime, occurrence!.durationTime));
      return;
    case "move-occurrence":
      occurrence!.startTime = normalizeRationalTime(operation.startTime);
      validateRational(occurrence!.startTime, "operation.startTime", false);
      if (operation.track !== undefined) {
        if (!Number.isInteger(operation.track) || operation.track < 0) throw new Error("TIMELINE_IR_OPERATION_INVALID: track must be a non-negative integer");
        occurrence!.track = operation.track;
      }
      timeline.sequence.durationTime = maxRational(timeline.sequence.durationTime, addRationalTimes(occurrence!.startTime, occurrence!.durationTime));
      return;
    case "set-gain":
      if (!Number.isFinite(operation.gainDb)) throw new Error("TIMELINE_IR_OPERATION_INVALID: gainDb must be finite");
      occurrence!.gainDb = operation.gainDb;
      return;
    case "remove-occurrence":
      timeline.sequence.occurrences = timeline.sequence.occurrences.filter(({ id }) => id !== operation.occurrenceId);
      timeline.sequence.storyElements = timeline.sequence.storyElements.filter(({ occurrenceId }) => occurrenceId !== operation.occurrenceId);
      return;
    case "add-marker":
      validateMarker(operation.marker);
      if (timeline.sequence.markers.some(({ id }) => id === operation.marker.id)) throw new Error(`TIMELINE_IR_OPERATION_INVALID: marker already exists: ${operation.marker.id}`);
      timeline.sequence.markers.push({ ...structuredClone(operation.marker), startTime: normalizeRationalTime(operation.marker.startTime), durationTime: normalizeRationalTime(operation.marker.durationTime) });
      return;
  }
}

function validateMarker(marker: TimelineIrMarker): void {
  requireText(marker.id, "marker.id");
  requireText(marker.name, `marker ${marker.id}.name`);
  validateRational(marker.startTime, `marker ${marker.id}.startTime`, false);
  validateRational(marker.durationTime, `marker ${marker.id}.durationTime`, false);
}

function storyElementToIr(element: StoryElement, binding?: (kind: TimelineIrBindingKind, identity: string) => TimelineIrBinding): TimelineIrStoryElement {
  return {
    id: element.id,
    kind: element.kind,
    startTime: requiredRational(element.startTime, `story element ${element.id} startTime`),
    durationTime: requiredRational(element.durationTime, `story element ${element.id} durationTime`),
    ...(element.lane !== undefined ? { lane: element.lane } : {}),
    ...(element.text !== undefined ? { text: element.text } : {}),
    ...(element.attachedTo ? { attachedTo: element.attachedTo } : {}),
    ...(binding ? { binding: binding("story-element", element.id) } : {}),
  };
}

function requiredRational(value: RationalTime | undefined, field: string): RationalTime {
  if (!value) throw new Error(`TIMELINE_IR_INVALID: ${field} is required`);
  validateRational(value, field, false);
  return normalizeRationalTime(value);
}

function validateRational(value: RationalTime, field: string, requirePositive: boolean): void {
  const parsed = parseRational(value, "TIMELINE_IR_INVALID");
  if (parsed.value < 0n) throw new Error(`TIMELINE_IR_INVALID: ${field} cannot be negative`);
  if (requirePositive && parsed.value <= 0n) throw new Error(`TIMELINE_IR_INVALID: ${field} must be positive`);
}

function validateRevision(revision: ContextRevision): void {
  requireText(revision?.id, "revision.id");
  if (!Number.isSafeInteger(revision.sequence) || revision.sequence < 0) throw new Error("TIMELINE_IR_INVALID: revision.sequence must be a non-negative safe integer");
  requireText(revision.timestamp, "revision.timestamp");
}

function validateBinding(binding: TimelineIrBinding | undefined, field: string): void {
  if (!binding) return;
  requireText(binding.provider, `${field}.provider`);
  requireText(binding.kind, `${field}.kind`);
  if (![
    "project",
    "sequence",
    "resource",
    "occurrence",
    "story-element",
  ].includes(binding.kind)) throw new Error(`TIMELINE_IR_INVALID: ${field}.kind is unsupported`);
  requireText(binding.identity, `${field}.identity`);
}

function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`TIMELINE_IR_INVALID: ${field} must be non-empty`);
}

function uniqueIds(values: string[], label: string): Set<string> {
  const ids = new Set<string>();
  for (const value of values) {
    requireText(value, `${label}.id`);
    if (ids.has(value)) throw new Error(`TIMELINE_IR_INVALID: duplicate ${label} id ${value}`);
    ids.add(value);
  }
  return ids;
}

function normalizeRationalTime(value: RationalTime): RationalTime {
  const parsed = parseRational(value, "TIMELINE_IR_INVALID");
  const absolute = parsed.value < 0n ? -parsed.value : parsed.value;
  const divisor = greatestCommonDivisor(absolute, parsed.timescale);
  return { value: String(parsed.value / divisor), timescale: String(parsed.timescale / divisor) };
}

function maxRational(left: RationalTime, right: RationalTime): RationalTime {
  const leftParts = parseRational(left, "TIMELINE_IR_INVALID");
  const rightParts = parseRational(right, "TIMELINE_IR_INVALID");
  return leftParts.value * rightParts.timescale >= rightParts.value * leftParts.timescale ? left : right;
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  while (right !== 0n) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left || 1n;
}

function nextRevision(timeline: TimelineIr, previous: ContextRevision, timestamp: string): ContextRevision {
  return { id: `ir:${timelineIrDigest(timeline)}`, sequence: previous.sequence + 1, timestamp };
}

function assertRevision(actual: ContextRevision, expected: ContextRevision): void {
  if (actual.id !== expected.id || actual.sequence !== expected.sequence) throw new Error("STALE_CONTEXT: desired timeline revision changed before editing");
}

function sameRevision(left: ContextRevision, right: ContextRevision): boolean {
  return left.id === right.id && left.sequence === right.sequence;
}

function changedIds(before: TimelineIr, after: TimelineIr): Pick<TimelineIrPreview, "changedOccurrenceIds" | "changedMarkerIds"> {
  const occurrenceIds = new Set([...before.sequence.occurrences, ...after.sequence.occurrences].map(({ id }) => id));
  const markerIds = new Set([...before.sequence.markers, ...after.sequence.markers].map(({ id }) => id));
  return {
    changedOccurrenceIds: [...occurrenceIds].filter((id) => JSON.stringify(before.sequence.occurrences.find((item) => item.id === id)) !== JSON.stringify(after.sequence.occurrences.find((item) => item.id === id))),
    changedMarkerIds: [...markerIds].filter((id) => JSON.stringify(before.sequence.markers.find((item) => item.id === id)) !== JSON.stringify(after.sequence.markers.find((item) => item.id === id))),
  };
}

function changedOccurrenceOrMarkers(changed: Pick<TimelineIrPreview, "changedOccurrenceIds" | "changedMarkerIds">): boolean {
  return changed.changedOccurrenceIds.length > 0 || changed.changedMarkerIds.length > 0;
}

function editState(state: EditingSessionState): EditingSessionState {
  return state === "possibly_stale" || state === "conflicted" || state === "rebased" || state === "waiting_for_materialization" ? state : "dirty";
}

function sourceName(source: string, fallback: string): string {
  return source.split(/[\\/]/).pop() || fallback;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value).filter(([, child]) => child !== undefined).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
