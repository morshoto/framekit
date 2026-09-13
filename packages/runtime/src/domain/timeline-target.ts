import type { ContextRevision, RationalTime } from "./primitives.js";
import type { Clip, ProjectSnapshot } from "./project.js";

/** A rational range addressed on one timeline. */
export interface TimelineTargetRange {
  start: RationalTime;
  end: RationalTime;
}

/** The immutable identity and coordinates captured for one timeline occurrence. */
export interface TimelineOccurrenceTarget {
  id: string;
  mediaId?: string;
  sourceStartTime?: RationalTime;
  startTime: RationalTime;
  durationTime: RationalTime;
}

/**
 * Stable addressing shared by background and headed providers.
 *
 * A native UI handle is intentionally not part of this contract. Providers may
 * derive a short-lived handle internally, but must bind it to this scope,
 * revision, identity, and exact frame grid before a write.
 */
export interface TimelineTarget {
  projectId: string;
  sequenceId: string;
  revision: ContextRevision;
  timelineStartTime: RationalTime;
  frameDuration: RationalTime;
  mediaId?: string;
  occurrence?: TimelineOccurrenceTarget;
  range?: TimelineTargetRange;
}

export interface TimelineTargetSelection {
  occurrenceId?: string;
  mediaId?: string;
  range?: TimelineTargetRange;
}

export interface TimelineTargetResolution {
  target: TimelineTarget;
  occurrence?: Clip;
}

/** Capture a target from a canonical snapshot without deriving identity from names or indexes. */
export function createTimelineTarget(
  snapshot: ProjectSnapshot,
  selection: TimelineTargetSelection = {},
): TimelineTarget {
  const frameDuration = snapshot.timeline.frameDuration;
  if (!frameDuration) {
    throw new Error("FRAME_ALIGNMENT_UNAVAILABLE: timeline frame duration is required for stable targeting");
  }

  const target: TimelineTarget = {
    projectId: snapshot.projectId,
    sequenceId: snapshot.timeline.id,
    revision: structuredClone(snapshot.revision),
    timelineStartTime: { value: "0", timescale: "1" },
    frameDuration: structuredClone(frameDuration),
    ...(selection.mediaId !== undefined ? { mediaId: selection.mediaId } : {}),
    ...(selection.range ? { range: structuredClone(selection.range) } : {}),
  };

  if (selection.occurrenceId !== undefined) {
    const occurrence = findUniqueOccurrence(snapshot, selection.occurrenceId);
    target.occurrence = occurrenceTarget(occurrence);
    if (target.mediaId !== undefined && target.mediaId !== occurrence.mediaId) {
      throw new Error(`TARGET_MISMATCH: occurrence ${occurrence.id} is bound to ${occurrence.mediaId ?? "no media"}`);
    }
    if (target.mediaId === undefined && occurrence.mediaId !== undefined) {
      target.mediaId = occurrence.mediaId;
    }
  }

  assertValidTimelineTarget(target);
  validateTargetCoordinates(snapshot, target);
  return target;
}

/** Resolve and validate an explicit target against the current canonical snapshot. */
export function resolveTimelineTarget(
  snapshot: ProjectSnapshot,
  target: TimelineTarget,
): TimelineTargetResolution {
  assertValidTimelineTarget(target);
  if (target.projectId !== snapshot.projectId || target.sequenceId !== snapshot.timeline.id) {
    throw new Error(
      `TARGET_MISMATCH: requested ${target.projectId}/${target.sequenceId} while ${snapshot.projectId}/${snapshot.timeline.id} is active`,
    );
  }
  if (!sameRevision(target.revision, snapshot.revision)) {
    throw new Error("STALE_CONTEXT: timeline target revision does not match current editor state");
  }
  if (!snapshot.timeline.frameDuration) {
    throw new Error("FRAME_ALIGNMENT_UNAVAILABLE: current timeline has no frame duration");
  }
  if (!sameRational(target.frameDuration, snapshot.timeline.frameDuration)) {
    throw new Error("FRAME_ALIGNMENT_REQUIRED: target frame duration does not match current timeline");
  }

  validateTargetCoordinates(snapshot, target);
  const occurrence = target.occurrence
    ? findUniqueOccurrence(snapshot, target.occurrence.id)
    : undefined;
  if (occurrence && target.occurrence) {
    assertOccurrenceBinding(target.occurrence, occurrence);
  }
  if (target.mediaId !== undefined && occurrence?.mediaId !== target.mediaId) {
    throw new Error(`TARGET_MISMATCH: target media ${target.mediaId} is not bound to occurrence ${occurrence?.id ?? "unknown"}`);
  }
  return { target: structuredClone(target), ...(occurrence ? { occurrence: structuredClone(occurrence) } : {}) };
}

/**
 * Verify that a post-write snapshot still addresses the same target.
 * Coordinates may change for trim and move; occurrence and media identity may
 * not change unless the operation explicitly removes the occurrence.
 */
export function assertTimelineTargetReadAfterWrite(
  target: TimelineTarget,
  before: ProjectSnapshot,
  after: ProjectSnapshot,
  options: { allowOccurrenceRemoval?: boolean } = {},
): void {
  resolveTimelineTarget(before, target);
  if (after.projectId !== target.projectId || after.timeline.id !== target.sequenceId) {
    throw new Error("TARGET_MISMATCH: read-after-write snapshot changed the addressed timeline");
  }

  if (target.mediaId !== undefined && target.occurrence) {
    const occurrence = findOccurrences(after, target.occurrence.id);
    if (occurrence.length === 0 && options.allowOccurrenceRemoval) return;
    if (occurrence.length === 0) {
      throw new Error(`TARGET_MISMATCH: read-after-write lost occurrence ${target.occurrence.id}`);
    }
    if (occurrence.length > 1) {
      throw new Error(`AMBIGUOUS_TIMELINE_TARGET: read-after-write duplicated occurrence ${target.occurrence.id}`);
    }
    if (occurrence[0]!.mediaId !== target.mediaId) {
      throw new Error(`TARGET_MISMATCH: read-after-write changed media for occurrence ${target.occurrence.id}`);
    }
  } else if (target.occurrence) {
    const occurrence = findOccurrences(after, target.occurrence.id);
    if (occurrence.length === 0 && options.allowOccurrenceRemoval) return;
    if (occurrence.length !== 1) {
      throw new Error(`TARGET_MISMATCH: read-after-write did not preserve occurrence ${target.occurrence.id}`);
    }
  }
}

/** Validate the shape of a target before any provider-specific resolution. */
export function assertValidTimelineTarget(target: TimelineTarget): void {
  requireNonEmpty(target.projectId, "projectId");
  requireNonEmpty(target.sequenceId, "sequenceId");
  requireNonEmpty(target.revision?.id, "revision.id");
  if (!Number.isInteger(target.revision?.sequence) || target.revision.sequence < 0) {
    throw new Error("INVALID_TIMELINE_TARGET: revision.sequence must be a non-negative integer");
  }
  requireNonEmpty(target.revision.timestamp, "revision.timestamp");
  parseRational(target.timelineStartTime, "INVALID_TIMELINE_TARGET: timelineStartTime");
  const frame = parseRational(target.frameDuration, "INVALID_TIMELINE_TARGET: frameDuration");
  if (frame.value <= 0n) throw new Error("INVALID_TIMELINE_TARGET: frameDuration must be positive");
  if (target.mediaId !== undefined) requireNonEmpty(target.mediaId, "mediaId");

  if (target.occurrence) {
    requireNonEmpty(target.occurrence.id, "occurrence.id");
    parseRational(target.occurrence.startTime, "INVALID_TIMELINE_TARGET: occurrence.startTime");
    const duration = parseRational(target.occurrence.durationTime, "INVALID_TIMELINE_TARGET: occurrence.durationTime");
    if (duration.value <= 0n) throw new Error("INVALID_TIMELINE_TARGET: occurrence duration must be positive");
    if (target.occurrence.mediaId !== undefined) requireNonEmpty(target.occurrence.mediaId, "occurrence.mediaId");
    if (target.occurrence.sourceStartTime) {
      parseRational(target.occurrence.sourceStartTime, "INVALID_TIMELINE_TARGET: occurrence.sourceStartTime");
    }
  }
  if (target.range) {
    parseRational(target.range.start, "INVALID_TIMELINE_TARGET: range.start");
    parseRational(target.range.end, "INVALID_TIMELINE_TARGET: range.end");
  }
}

function validateTargetCoordinates(snapshot: ProjectSnapshot, target: TimelineTarget): void {
  const frame = parseRational(target.frameDuration, "INVALID_TIMELINE_TARGET: frameDuration");
  const origin = parseRational(target.timelineStartTime, "INVALID_TIMELINE_TARGET: timelineStartTime");
  const timelineDuration = snapshot.timeline.durationTime
    ? parseRational(snapshot.timeline.durationTime, "INVALID_PROJECT_STATE: timeline duration")
    : undefined;
  const timelineEnd = timelineDuration
    ? addRational(origin, timelineDuration)
    : undefined;

  const validatePoint = (time: RationalTime, label: string): void => {
    const point = parseRational(time, `INVALID_TIMELINE_TARGET: ${label}`);
    if (!isFrameAligned(point, origin, frame)) {
      throw new Error(`FRAME_ALIGNMENT_REQUIRED: ${label} is not aligned to the sequence frame duration`);
    }
    if (compareRational(point, origin) < 0 || (timelineEnd && compareRational(point, timelineEnd) > 0)) {
      throw new Error(`TARGET_MISMATCH: ${label} is outside the addressed timeline`);
    }
  };

  if (target.occurrence) {
    validatePoint(target.occurrence.startTime, "occurrence.startTime");
    const occurrenceEnd = addRational(
      parseRational(target.occurrence.startTime, "INVALID_TIMELINE_TARGET: occurrence.startTime"),
      parseRational(target.occurrence.durationTime, "INVALID_TIMELINE_TARGET: occurrence.durationTime"),
    );
    validatePoint({ value: occurrenceEnd.value.toString(), timescale: occurrenceEnd.timescale.toString() }, "occurrence.endTime");
  }
  if (target.range) {
    validatePoint(target.range.start, "range.start");
    validatePoint(target.range.end, "range.end");
    if (compareRational(parseRational(target.range.end, "INVALID_TIMELINE_TARGET: range.end"), parseRational(target.range.start, "INVALID_TIMELINE_TARGET: range.start")) <= 0) {
      throw new Error("INVALID_TIMELINE_TARGET: range.end must be greater than range.start");
    }
  }
}

function occurrenceTarget(occurrence: Clip): TimelineOccurrenceTarget {
  return {
    id: occurrence.id,
    ...(occurrence.mediaId ? { mediaId: occurrence.mediaId } : {}),
    ...(occurrence.sourceStartTime ? { sourceStartTime: structuredClone(occurrence.sourceStartTime) } : {}),
    startTime: structuredClone(occurrence.startTime),
    durationTime: structuredClone(occurrence.durationTime),
  };
}

function findUniqueOccurrence(snapshot: ProjectSnapshot, id: string): Clip {
  const matches = findOccurrences(snapshot, id);
  if (matches.length === 0) throw new Error(`TIMELINE_TARGET_NOT_FOUND: occurrence ${id}`);
  if (matches.length > 1) throw new Error(`AMBIGUOUS_TIMELINE_TARGET: occurrence ${id}`);
  return matches[0]!;
}

function findOccurrences(snapshot: ProjectSnapshot, id: string): Clip[] {
  return snapshot.timeline.clips.filter((candidate) => candidate.id === id);
}

function assertOccurrenceBinding(target: TimelineOccurrenceTarget, occurrence: Clip): void {
  if (target.mediaId !== occurrence.mediaId
    || !sameRational(target.startTime, occurrence.startTime)
    || !sameRational(target.durationTime, occurrence.durationTime)
    || (target.sourceStartTime !== undefined
      && (!occurrence.sourceStartTime || !sameRational(target.sourceStartTime, occurrence.sourceStartTime)))) {
    throw new Error(`TARGET_MISMATCH: occurrence ${target.id} identity or coordinates changed`);
  }
}

function requireNonEmpty(value: string | undefined, field: string): asserts value is string {
  if (!value?.trim()) throw new Error(`INVALID_TIMELINE_TARGET: ${field} is required`);
}

function parseRational(time: RationalTime, errorPrefix: string): { value: bigint; timescale: bigint } {
  if (!time || !/^-?\d+$/.test(time.value) || !/^\d+$/.test(time.timescale)) {
    throw new Error(`${errorPrefix} requires an integer value and timescale`);
  }
  const value = BigInt(time.value);
  const timescale = BigInt(time.timescale);
  if (timescale <= 0n) throw new Error(`${errorPrefix} requires a positive timescale`);
  return { value, timescale };
}

function addRational(
  left: { value: bigint; timescale: bigint },
  right: { value: bigint; timescale: bigint },
): { value: bigint; timescale: bigint } {
  return normalizeRational(
    left.value * right.timescale + right.value * left.timescale,
    left.timescale * right.timescale,
  );
}

function compareRational(left: { value: bigint; timescale: bigint }, right: { value: bigint; timescale: bigint }): number {
  const difference = left.value * right.timescale - right.value * left.timescale;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function sameRational(left: RationalTime, right: RationalTime): boolean {
  return compareRational(parseRational(left, "INVALID_TIMELINE_TARGET"), parseRational(right, "INVALID_TIMELINE_TARGET")) === 0;
}

function isFrameAligned(
  time: { value: bigint; timescale: bigint },
  origin: { value: bigint; timescale: bigint },
  frame: { value: bigint; timescale: bigint },
): boolean {
  const deltaNumerator = (time.value * origin.timescale - origin.value * time.timescale) * frame.timescale;
  const deltaDenominator = time.timescale * origin.timescale * frame.value;
  return deltaDenominator > 0n && deltaNumerator % deltaDenominator === 0n;
}

function normalizeRational(value: bigint, timescale: bigint): { value: bigint; timescale: bigint } {
  const divisor = greatestCommonDivisor(value < 0n ? -value : value, timescale);
  return { value: value / divisor, timescale: timescale / divisor };
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  while (right !== 0n) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left || 1n;
}

function sameRevision(left: ContextRevision, right: ContextRevision): boolean {
  return left.id === right.id && left.sequence === right.sequence;
}
