import { createHash } from "node:crypto";
import type { ContextRevision, RationalTime } from "../domain/primitives.js";
import type { MediaContext } from "../domain/media.js";
import type { ProjectSnapshot, StoryElement } from "../domain/project.js";
import { addRationalTimes } from "./rational-time.js";
import { parseRational } from "./rational-time.js";
import { subtractRationalTimes } from "./rational-time.js";
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
  sourceKind?: "local-file";
  sourceDigest?: string;
  metadata?: TimelineIrMediaMetadata;
  binding?: TimelineIrBinding;
}

export interface TimelineIrMediaMetadata {
  durationTime: RationalTime;
  streams: TimelineIrMediaStream[];
}

export interface TimelineIrMediaStream {
  kind: "video" | "audio";
  codec?: string;
  width?: number;
  height?: number;
  frameRate?: RationalTime;
  sampleRate?: number;
  channels?: number;
}

export interface TimelineIrTransform {
  /** Multipliers relative to the source media's untransformed dimensions. */
  scaleX: number;
  scaleY: number;
  /** Timeline-pixel offsets from the output canvas center; +x is right and +y is up. */
  positionX?: number;
  positionY?: number;
  /** Counter-clockwise rotation in degrees around the media center. */
  rotationDegrees?: number;
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
  transform?: TimelineIrTransform;
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

export interface TimelineIrTitleStyle {
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  alignment?: "left" | "center" | "right";
}

export interface TimelineIrTitle {
  id: string;
  text: string;
  startTime: RationalTime;
  durationTime: RationalTime;
  /** Connected/overlay lane; zero is reserved for the primary storyline. */
  lane: number;
  style?: TimelineIrTitleStyle;
  /** Normalized output coordinates in the centered canvas space: x and y are in [-1, 1], +x is right, and +y is up. */
  position?: { x: number; y: number };
}

export interface TimelineIrTransition {
  id: string;
  kind: "cross-dissolve";
  beforeOccurrenceId: string;
  afterOccurrenceId: string;
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
    titles?: TimelineIrTitle[];
    transitions?: TimelineIrTransition[];
    binding?: TimelineIrBinding;
  };
  resources: TimelineIrResource[];
  revision: ContextRevision;
}

export type TimelineIrEditOperation =
  | { type: "insert-occurrence"; occurrence: TimelineIrOccurrence; placement?: "append" | "insert" }
  | { type: "rename-occurrence"; occurrenceId: string; name: string }
  | { type: "trim-occurrence"; occurrenceId: string; sourceStartTime?: RationalTime; durationTime: RationalTime }
  | { type: "move-occurrence"; occurrenceId: string; startTime: RationalTime; track?: number }
  | { type: "split-occurrence"; occurrenceId: string; splitOffsetTime: RationalTime; newOccurrenceId: string }
  | { type: "set-gain"; occurrenceId: string; gainDb: number }
  | { type: "set-transform"; occurrenceId: string; transform: TimelineIrTransform }
  | { type: "remove-occurrence"; occurrenceId: string }
  | { type: "add-marker"; marker: TimelineIrMarker }
  | { type: "add-title"; title: TimelineIrTitle }
  | { type: "remove-title"; titleId: string }
  | { type: "add-transition"; transition: TimelineIrTransition }
  | { type: "remove-transition"; transitionId: string };

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
  changedTitleIds: string[];
  changedTransitionIds: string[];
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
      state: changedTimelineElements(changed) ? editState(this.value.state) : this.value.state,
    };
  }

  public apply(
    operations: TimelineIrEditOperation[],
    expectedRevision: ContextRevision = this.value.desired.revision,
  ): EditingSessionApplyResult {
    const preview = this.preview(operations, expectedRevision);
    this.value.desired = preview.after;
    if (changedTimelineElements(preview)) {
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
    ...(clip.scale !== undefined || clip.position ? {
      transform: {
        scaleX: clip.scale ?? 1,
        scaleY: clip.scale ?? 1,
        ...(clip.position ? { positionX: clip.position.x, positionY: clip.position.y } : {}),
      },
    } : {}),
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
  if (timeline.sequence.titles !== undefined && !Array.isArray(timeline.sequence.titles)) throw new Error("TIMELINE_IR_INVALID: titles must be an array");
  if (timeline.sequence.transitions !== undefined && !Array.isArray(timeline.sequence.transitions)) throw new Error("TIMELINE_IR_INVALID: transitions must be an array");
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
    if (resource.sourceKind !== undefined && resource.sourceKind !== "local-file") {
      throw new Error(`TIMELINE_IR_INVALID: resource ${resource.id} has unsupported sourceKind`);
    }
    if (resource.metadata) validateMediaMetadata(resource.metadata, `resource ${resource.id}.metadata`);
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
    const resource = occurrence.mediaId ? timeline.resources.find(({ id }) => id === occurrence.mediaId) : undefined;
    if (resource?.metadata) {
      const sourceStartTime = occurrence.sourceStartTime ?? { value: "0", timescale: "1" };
      const sourceEndTime = addRationalTimes(sourceStartTime, occurrence.durationTime, "TIMELINE_IR_INVALID");
      if (compareRational(sourceEndTime, resource.metadata.durationTime) > 0) {
        throw new Error(`TIMELINE_IR_INVALID: occurrence ${occurrence.id} source range exceeds resource ${resource.id}`);
      }
    }
    if (occurrence.gainDb !== undefined && !Number.isFinite(occurrence.gainDb)) throw new Error(`TIMELINE_IR_INVALID: occurrence ${occurrence.id}.gainDb must be finite`);
    if (occurrence.transform) validateTransform(occurrence.transform, `occurrence ${occurrence.id}.transform`);
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
  uniqueIds((timeline.sequence.titles ?? []).map(({ id }) => id), "title");
  for (const title of timeline.sequence.titles ?? []) validateTitle(title);
  uniqueIds((timeline.sequence.transitions ?? []).map(({ id }) => id), "transition");
  for (const transition of timeline.sequence.transitions ?? []) validateTransition(timeline, transition);
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

function validateMediaMetadata(metadata: TimelineIrMediaMetadata, field: string): void {
  if (!metadata || typeof metadata !== "object") throw new Error(`TIMELINE_IR_INVALID: ${field} must be an object`);
  validateRational(metadata.durationTime, `${field}.durationTime`, true);
  if (!Array.isArray(metadata.streams) || metadata.streams.length === 0) {
    throw new Error(`TIMELINE_IR_INVALID: ${field}.streams must be non-empty`);
  }
  for (const [index, stream] of metadata.streams.entries()) {
    const streamField = `${field}.streams[${index}]`;
    if (!stream || (stream.kind !== "video" && stream.kind !== "audio")) {
      throw new Error(`TIMELINE_IR_INVALID: ${streamField}.kind is unsupported`);
    }
    if (stream.codec !== undefined) requireText(stream.codec, `${streamField}.codec`);
    if (stream.kind === "video") {
      requirePositiveInteger(stream.width, `${streamField}.width`);
      requirePositiveInteger(stream.height, `${streamField}.height`);
      if (!stream.frameRate) throw new Error(`TIMELINE_IR_INVALID: ${streamField}.frameRate is required`);
      validateRational(stream.frameRate, `${streamField}.frameRate`, true);
    } else {
      requirePositiveInteger(stream.sampleRate, `${streamField}.sampleRate`);
      requirePositiveInteger(stream.channels, `${streamField}.channels`);
    }
  }
}

export function timelineIrDigest(timeline: TimelineIr): string {
  const content = structuredClone(timeline);
  delete (content as Partial<TimelineIr>).revision;
  return createHash("sha256").update(stableJson(content)).digest("hex");
}

function applyOperation(timeline: TimelineIr, operation: TimelineIrEditOperation): void {
  const occurrenceId = "occurrenceId" in operation ? operation.occurrenceId : undefined;
  const occurrence = occurrenceId ? timeline.sequence.occurrences.find(({ id }) => id === occurrenceId) : undefined;
  if (![
    "add-marker",
    "insert-occurrence",
    "add-title",
    "remove-title",
    "add-transition",
    "remove-transition",
  ].includes(operation.type) && !occurrence) {
    throw new Error(`TIMELINE_IR_OPERATION_INVALID: occurrence not found: ${occurrenceId}`);
  }
  switch (operation.type) {
    case "insert-occurrence": {
      if (timeline.sequence.occurrences.some(({ id }) => id === operation.occurrence.id)) {
        throw new Error(`TIMELINE_IR_OPERATION_INVALID: occurrence already exists: ${operation.occurrence.id}`);
      }
      const inserted = structuredClone(operation.occurrence);
      if (operation.placement === "append") inserted.startTime = normalizeRationalTime(timeline.sequence.durationTime);
      timeline.sequence.occurrences.push(inserted);
      timeline.sequence.durationTime = maxRational(
        timeline.sequence.durationTime,
        addRationalTimes(inserted.startTime, inserted.durationTime, "TIMELINE_IR_OPERATION_INVALID"),
      );
      canonicalizeOccurrences(timeline);
      return;
    }
    case "rename-occurrence":
      requireText(operation.name, "operation.name");
      occurrence!.name = operation.name;
      return;
    case "trim-occurrence":
      occurrence!.durationTime = normalizeRationalTime(operation.durationTime);
      validateRational(occurrence!.durationTime, "operation.durationTime", true);
      if (operation.sourceStartTime) {
        occurrence!.sourceStartTime = normalizeRationalTime(operation.sourceStartTime);
        validateRational(occurrence!.sourceStartTime, "operation.sourceStartTime", false);
      }
      recomputeSequenceDuration(timeline);
      return;
    case "move-occurrence":
      occurrence!.startTime = normalizeRationalTime(operation.startTime);
      validateRational(occurrence!.startTime, "operation.startTime", false);
      if (operation.track !== undefined) {
        if (!Number.isInteger(operation.track) || operation.track < 0) throw new Error("TIMELINE_IR_OPERATION_INVALID: track must be a non-negative integer");
        occurrence!.track = operation.track;
      }
      recomputeSequenceDuration(timeline);
      canonicalizeOccurrences(timeline);
      return;
    case "split-occurrence": {
      requireText(operation.newOccurrenceId, "operation.newOccurrenceId");
      if (timeline.sequence.occurrences.some(({ id }) => id === operation.newOccurrenceId)) {
        throw new Error(`TIMELINE_IR_OPERATION_INVALID: occurrence already exists: ${operation.newOccurrenceId}`);
      }
      const splitOffsetTime = normalizeRationalTime(operation.splitOffsetTime);
      validateRational(splitOffsetTime, "operation.splitOffsetTime", true);
      if (compareRational(splitOffsetTime, occurrence!.durationTime) >= 0) {
        throw new Error("TIMELINE_IR_OPERATION_INVALID: splitOffsetTime must be inside the occurrence duration");
      }
      const right = structuredClone(occurrence!);
      right.id = operation.newOccurrenceId;
      right.startTime = addRationalTimes(occurrence!.startTime, splitOffsetTime, "TIMELINE_IR_OPERATION_INVALID");
      right.durationTime = subtractRationalTimes(occurrence!.durationTime, splitOffsetTime, "TIMELINE_IR_OPERATION_INVALID");
      const sourceStartTime = occurrence!.sourceStartTime ?? { value: "0", timescale: "1" };
      right.sourceStartTime = addRationalTimes(sourceStartTime, splitOffsetTime, "TIMELINE_IR_OPERATION_INVALID");
      if (right.binding?.kind === "occurrence") delete right.binding;
      occurrence!.durationTime = splitOffsetTime;
      timeline.sequence.occurrences.push(right);
      canonicalizeOccurrences(timeline);
      return;
    }
    case "set-gain":
      if (!Number.isFinite(operation.gainDb)) throw new Error("TIMELINE_IR_OPERATION_INVALID: gainDb must be finite");
      occurrence!.gainDb = operation.gainDb;
      return;
    case "set-transform":
      validateTransform(operation.transform, "operation.transform");
      occurrence!.transform = structuredClone(operation.transform);
      return;
    case "remove-occurrence":
      timeline.sequence.occurrences = timeline.sequence.occurrences.filter(({ id }) => id !== operation.occurrenceId);
      timeline.sequence.storyElements = timeline.sequence.storyElements.filter(({ occurrenceId }) => occurrenceId !== operation.occurrenceId);
      recomputeSequenceDuration(timeline);
      return;
    case "add-marker":
      validateMarker(operation.marker);
      if (timeline.sequence.markers.some(({ id }) => id === operation.marker.id)) throw new Error(`TIMELINE_IR_OPERATION_INVALID: marker already exists: ${operation.marker.id}`);
      timeline.sequence.markers.push({ ...structuredClone(operation.marker), startTime: normalizeRationalTime(operation.marker.startTime), durationTime: normalizeRationalTime(operation.marker.durationTime) });
      return;
    case "add-title": {
      const titles = timeline.sequence.titles ??= [];
      if (titles.some(({ id }) => id === operation.title.id)) throw new Error(`TIMELINE_IR_OPERATION_INVALID: title already exists: ${operation.title.id}`);
      validateTitle(operation.title);
      titles.push(structuredClone(operation.title));
      recomputeSequenceDuration(timeline);
      return;
    }
    case "remove-title": {
      const titles = timeline.sequence.titles ?? [];
      if (!titles.some(({ id }) => id === operation.titleId)) throw new Error(`TIMELINE_IR_OPERATION_INVALID: title not found: ${operation.titleId}`);
      timeline.sequence.titles = titles.filter(({ id }) => id !== operation.titleId);
      recomputeSequenceDuration(timeline);
      return;
    }
    case "add-transition": {
      const transitions = timeline.sequence.transitions ??= [];
      if (transitions.some(({ id }) => id === operation.transition.id)) throw new Error(`TIMELINE_IR_OPERATION_INVALID: transition already exists: ${operation.transition.id}`);
      validateTransition(timeline, operation.transition);
      transitions.push(structuredClone(operation.transition));
      return;
    }
    case "remove-transition": {
      const transitions = timeline.sequence.transitions ?? [];
      if (!transitions.some(({ id }) => id === operation.transitionId)) throw new Error(`TIMELINE_IR_OPERATION_INVALID: transition not found: ${operation.transitionId}`);
      timeline.sequence.transitions = transitions.filter(({ id }) => id !== operation.transitionId);
      return;
    }
    default:
      throw new Error(`TIMELINE_IR_UNSUPPORTED: unsupported Timeline IR operation: ${(operation as { type?: unknown }).type ?? "unknown"}`);
  }
}

function canonicalizeOccurrences(timeline: TimelineIr): void {
  timeline.sequence.occurrences.sort((left, right) => {
    const start = compareRational(left.startTime, right.startTime);
    if (start !== 0) return start;
    if (left.track !== right.track) return left.track - right.track;
    return left.id.localeCompare(right.id);
  });
}

function recomputeSequenceDuration(timeline: TimelineIr): void {
  let durationTime: RationalTime = { value: "0", timescale: "1" };
  for (const item of [...timeline.sequence.occurrences, ...timeline.sequence.storyElements]) {
    durationTime = maxRational(durationTime, addRationalTimes(item.startTime, item.durationTime, "TIMELINE_IR_OPERATION_INVALID"));
  }
  for (const title of timeline.sequence.titles ?? []) {
    durationTime = maxRational(durationTime, addRationalTimes(title.startTime, title.durationTime, "TIMELINE_IR_OPERATION_INVALID"));
  }
  timeline.sequence.durationTime = durationTime;
}

function validateMarker(marker: TimelineIrMarker): void {
  requireText(marker.id, "marker.id");
  requireText(marker.name, `marker ${marker.id}.name`);
  validateRational(marker.startTime, `marker ${marker.id}.startTime`, false);
  validateRational(marker.durationTime, `marker ${marker.id}.durationTime`, false);
}

function validateTitle(title: TimelineIrTitle): void {
  requireText(title.id, "title.id");
  requireText(title.text, `title ${title.id}.text`);
  validateRational(title.startTime, `title ${title.id}.startTime`, false);
  validateRational(title.durationTime, `title ${title.id}.durationTime`, true);
  if (!Number.isInteger(title.lane) || title.lane < 1) throw new Error(`TIMELINE_IR_INVALID: title ${title.id}.lane must be a positive integer`);
  if (title.position && (![title.position.x, title.position.y].every(Number.isFinite)
    || ![title.position.x, title.position.y].every((value) => value >= -1 && value <= 1))) {
    throw new Error(`TIMELINE_IR_INVALID: title ${title.id}.position must use normalized coordinates in [-1, 1]`);
  }
  if (title.style) {
    if (title.style.fontFamily !== undefined) requireText(title.style.fontFamily, `title ${title.id}.style.fontFamily`);
    if (title.style.fontSize !== undefined && (!Number.isFinite(title.style.fontSize) || title.style.fontSize <= 0)) {
      throw new Error(`TIMELINE_IR_INVALID: title ${title.id}.style.fontSize must be positive`);
    }
    if (title.style.color !== undefined) requireText(title.style.color, `title ${title.id}.style.color`);
    if (title.style.alignment !== undefined && !["left", "center", "right"].includes(title.style.alignment)) {
      throw new Error(`TIMELINE_IR_INVALID: title ${title.id}.style.alignment is unsupported`);
    }
  }
}

function validateTransition(timeline: TimelineIr, transition: TimelineIrTransition): void {
  requireText(transition.id, "transition.id");
  if (transition.kind !== "cross-dissolve") throw new Error(`TIMELINE_IR_INVALID: transition ${transition.id}.kind is unsupported`);
  requireText(transition.beforeOccurrenceId, `transition ${transition.id}.beforeOccurrenceId`);
  requireText(transition.afterOccurrenceId, `transition ${transition.id}.afterOccurrenceId`);
  validateRational(transition.durationTime, `transition ${transition.id}.durationTime`, true);
  const occurrences = timeline.sequence.occurrences;
  const before = occurrences.find(({ id }) => id === transition.beforeOccurrenceId);
  const after = occurrences.find(({ id }) => id === transition.afterOccurrenceId);
  if (!before || !after) throw new Error(`TIMELINE_IR_INVALID: transition ${transition.id} participants must exist`);
  const sameTrack = occurrences.filter(({ track }) => track === before.track);
  const beforeIndex = sameTrack.findIndex(({ id }) => id === before.id);
  const afterIndex = sameTrack.findIndex(({ id }) => id === after.id);
  if (before.track !== after.track || beforeIndex < 0 || afterIndex !== beforeIndex + 1) {
    throw new Error(`TIMELINE_IR_INVALID: transition ${transition.id} participants must be adjacent on one track`);
  }
  if (compareRational(addRationalTimes(before.startTime, before.durationTime), after.startTime) !== 0) {
    throw new Error(`TIMELINE_IR_INVALID: transition ${transition.id} participants must meet at one boundary`);
  }
  if (compareRational(transition.durationTime, before.durationTime) > 0 || compareRational(transition.durationTime, after.durationTime) > 0) {
    throw new Error(`TIMELINE_IR_INVALID: transition ${transition.id}.durationTime exceeds a participant duration`);
  }
}

function validateTransform(transform: TimelineIrTransform, field: string): void {
  if (!transform || typeof transform !== "object") throw new Error(`TIMELINE_IR_INVALID: ${field} must be an object`);
  const allowedKeys = new Set(["scaleX", "scaleY", "positionX", "positionY", "rotationDegrees"]);
  for (const key of Object.keys(transform)) {
    if (!allowedKeys.has(key)) throw new Error(`TIMELINE_IR_INVALID: ${field}.${key} is not supported`);
  }
  if (!Number.isFinite(transform.scaleX) || transform.scaleX <= 0) throw new Error(`TIMELINE_IR_INVALID: ${field}.scaleX must be positive`);
  if (!Number.isFinite(transform.scaleY) || transform.scaleY <= 0) throw new Error(`TIMELINE_IR_INVALID: ${field}.scaleY must be positive`);
  for (const [name, value] of [
    ["positionX", transform.positionX],
    ["positionY", transform.positionY],
    ["rotationDegrees", transform.rotationDegrees],
  ] as const) {
    if (value !== undefined && !Number.isFinite(value)) throw new Error(`TIMELINE_IR_INVALID: ${field}.${name} must be finite`);
  }
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

function compareRational(left: RationalTime, right: RationalTime): number {
  const leftParts = parseRational(left, "TIMELINE_IR_INVALID");
  const rightParts = parseRational(right, "TIMELINE_IR_INVALID");
  const difference = leftParts.value * rightParts.timescale - rightParts.value * leftParts.timescale;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
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

function requirePositiveInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`TIMELINE_IR_INVALID: ${field} must be a positive integer`);
  }
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

function changedIds(before: TimelineIr, after: TimelineIr): Pick<TimelineIrPreview, "changedOccurrenceIds" | "changedMarkerIds" | "changedTitleIds" | "changedTransitionIds"> {
  const occurrenceIds = new Set([...before.sequence.occurrences, ...after.sequence.occurrences].map(({ id }) => id));
  const markerIds = new Set([...before.sequence.markers, ...after.sequence.markers].map(({ id }) => id));
  const titleIds = new Set([
    ...(before.sequence.titles ?? []).map(({ id }) => id),
    ...(after.sequence.titles ?? []).map(({ id }) => id),
  ]);
  const transitionIds = new Set([
    ...(before.sequence.transitions ?? []).map(({ id }) => id),
    ...(after.sequence.transitions ?? []).map(({ id }) => id),
  ]);
  return {
    changedOccurrenceIds: [...occurrenceIds].filter((id) => JSON.stringify(before.sequence.occurrences.find((item) => item.id === id)) !== JSON.stringify(after.sequence.occurrences.find((item) => item.id === id))),
    changedMarkerIds: [...markerIds].filter((id) => JSON.stringify(before.sequence.markers.find((item) => item.id === id)) !== JSON.stringify(after.sequence.markers.find((item) => item.id === id))),
    changedTitleIds: [...titleIds].filter((id) => JSON.stringify(before.sequence.titles?.find((item) => item.id === id)) !== JSON.stringify(after.sequence.titles?.find((item) => item.id === id))),
    changedTransitionIds: [...transitionIds].filter((id) => JSON.stringify(before.sequence.transitions?.find((item) => item.id === id)) !== JSON.stringify(after.sequence.transitions?.find((item) => item.id === id))),
  };
}

function changedTimelineElements(changed: Pick<TimelineIrPreview, "changedOccurrenceIds" | "changedMarkerIds" | "changedTitleIds" | "changedTransitionIds">): boolean {
  return changed.changedOccurrenceIds.length > 0
    || changed.changedMarkerIds.length > 0
    || changed.changedTitleIds.length > 0
    || changed.changedTransitionIds.length > 0;
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
