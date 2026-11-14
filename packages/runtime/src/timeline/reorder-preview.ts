import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Clip, ProjectSnapshot } from "../domain/project.js";
import type { ContextRevision, RationalTime } from "../domain/primitives.js";
import { addRationalTimes, parseRational } from "./rational-time.js";

export type PrimaryStorylineDestination =
  | { kind: "start" }
  | { kind: "end" }
  | { kind: "before"; occurrenceId: string }
  | { kind: "after"; occurrenceId: string };

export interface PrimaryStorylineReorderPreview {
  projectId: string;
  sequenceId: string;
  revision: ContextRevision;
  snapshotDigest: string;
  occurrenceId: string;
  moving: Clip;
  source: string;
  destination: PrimaryStorylineDestination;
  noOp: boolean;
  before: Clip[];
  after: Clip[];
}

function compare(left: RationalTime, right: RationalTime): number {
  const a = parseRational(left, "REORDER_INVALID");
  const b = parseRational(right, "REORDER_INVALID");
  const difference = a.value * b.timescale - b.value * a.timescale;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function snapshotDigest(snapshot: ProjectSnapshot): string {
  const json = JSON.stringify(snapshot, (_key, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  });
  return createHash("sha256").update(json).digest("hex");
}

/** Reject a preview if its complete baseline or planned content has changed. */
export function assertReorderPreviewCurrent(preview: PrimaryStorylineReorderPreview, snapshot: ProjectSnapshot): void {
  try {
    if (preview.snapshotDigest !== snapshotDigest(snapshot)
      || !isDeepStrictEqual(preview, previewPrimaryStorylineReorder(snapshot, preview.occurrenceId, preview.destination))) {
      throw new Error("preview mismatch");
    }
  } catch (error) {
    throw new Error("REORDER_PREVIEW_STALE: target, revision, content, or preview changed", { cause: error });
  }
}

function assertFiniteNumbers(value: unknown): void {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("REORDER_INVALID: non-finite snapshot value");
  if (Array.isArray(value)) { for (const item of value) assertFiniteNumbers(item); }
  else if (value && typeof value === "object") { for (const child of Object.values(value)) assertFiniteNumbers(child); }
}

function assertNumericTime(value: number, exact: RationalTime): void {
  const time = parseRational(exact, "REORDER_INVALID");
  const seconds = Number(time.value) / Number(time.timescale);
  if (!Number.isFinite(seconds) || !Number.isFinite(value)
    || Math.abs(value - seconds) > Number.EPSILON * Math.max(1, Math.abs(value), Math.abs(seconds)) * 8) {
    throw new Error("REORDER_INVALID: numeric and rational timing disagree");
  }
}

/** Plan a contiguous primary-storyline reorder without dispatching an editor operation. */
export function previewPrimaryStorylineReorder(
  snapshot: ProjectSnapshot,
  occurrenceId: string,
  destination: PrimaryStorylineDestination,
): PrimaryStorylineReorderPreview {
  if (!destination || typeof destination !== "object"
    || !["start", "end", "before", "after"].includes(destination.kind)
    || ((destination.kind === "before" || destination.kind === "after") && (typeof destination.occurrenceId !== "string" || !destination.occurrenceId))) {
    throw new Error("REORDER_INVALID: destination is invalid");
  }
  assertFiniteNumbers(snapshot);
  if (!snapshot.projectId || !snapshot.timeline.id || !snapshot.revision.id || !Number.isSafeInteger(snapshot.revision.sequence) || snapshot.revision.sequence < 0) {
    throw new Error("REORDER_INVALID: target and revision are required");
  }
  if (snapshot.timeline.markers.length || snapshot.timeline.captions.length
    || snapshot.timeline.storyElements.some((item) => item.kind !== "asset-clip")) {
    throw new Error("REORDER_UNSUPPORTED: timeline structure requires independent verification");
  }
  const clips = [...snapshot.timeline.clips].sort((a, b) => compare(a.startTime, b.startTime));
  const ids = new Set<string>();
  const mediaIds = new Set<string>();
  for (const media of snapshot.media) {
    if (!media.mediaId || !media.source || mediaIds.has(media.mediaId)) throw new Error("REORDER_INVALID: media source binding is incomplete or ambiguous");
    mediaIds.add(media.mediaId);
  }
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index]!;
    if (!clip.id || ids.has(clip.id) || !clip.mediaId || !mediaIds.has(clip.mediaId)) throw new Error("REORDER_INVALID: occurrence identity or source binding is incomplete");
    ids.add(clip.id);
    if (clip.track !== 0 || clip.attachedTo || !clip.sourceStartTime) throw new Error("REORDER_UNSUPPORTED: primary occurrence or source range is unavailable");
    parseRational(clip.sourceStartTime, "REORDER_INVALID");
    assertNumericTime(clip.start, clip.startTime);
    assertNumericTime(clip.duration, clip.durationTime);
    if (clip.sourceStart !== undefined) assertNumericTime(clip.sourceStart, clip.sourceStartTime);
    if (compare(clip.durationTime, { value: "0", timescale: "1" }) <= 0) throw new Error("REORDER_INVALID: duration must be positive");
    if (index > 0 && compare(addRationalTimes(clips[index - 1]!.startTime, clips[index - 1]!.durationTime), clip.startTime) !== 0) {
      throw new Error("REORDER_UNSUPPORTED: primary storyline is not contiguous");
    }
  }
  if (snapshot.timeline.storyElements.length !== clips.length) {
    throw new Error("REORDER_UNSUPPORTED: story elements are incomplete or unaccounted");
  }
  const storyIds = new Set<string>();
  for (const element of snapshot.timeline.storyElements) {
    const clip = clips.find((item) => item.id === element.id);
    if (!clip || storyIds.has(element.id) || element.mediaId !== clip.mediaId
      || !element.startTime || !element.durationTime
      || compare(element.startTime, clip.startTime) !== 0 || compare(element.durationTime, clip.durationTime) !== 0
      || (element.lane !== undefined && element.lane !== 0) || element.attachedTo) {
      throw new Error("REORDER_UNSUPPORTED: story element does not match a primary occurrence");
    }
    storyIds.add(element.id);
  }
  const oldIndex = clips.findIndex((clip) => clip.id === occurrenceId);
  if (oldIndex < 0) throw new Error("REORDER_TARGET_NOT_FOUND: moving occurrence is missing");
  if ((destination.kind === "before" || destination.kind === "after") && !ids.has(destination.occurrenceId)) {
    throw new Error("REORDER_TARGET_NOT_FOUND: destination occurrence is missing");
  }
  const selected = clips[oldIndex]!;
  const source = snapshot.media.find((media) => media.mediaId === selected.mediaId)!.source;
  const result: PrimaryStorylineReorderPreview = { projectId: snapshot.projectId, sequenceId: snapshot.timeline.id, revision: structuredClone(snapshot.revision), snapshotDigest: snapshotDigest(snapshot), occurrenceId, moving: structuredClone(selected), source, destination: structuredClone(destination), noOp: true, before: [], after: [] };
  if ((destination.kind === "before" || destination.kind === "after") && destination.occurrenceId === occurrenceId) return result;
  const reordered = [...clips];
  const [moving] = reordered.splice(oldIndex, 1);
  const slot = destination.kind === "start" ? 0 : destination.kind === "end" ? reordered.length
    : reordered.findIndex((clip) => clip.id === destination.occurrenceId) + (destination.kind === "after" ? 1 : 0);
  reordered.splice(slot, 0, moving!);
  const newIndex = reordered.findIndex((clip) => clip.id === occurrenceId);
  if (newIndex === oldIndex) return result;
  const first = Math.min(oldIndex, newIndex);
  const last = Math.max(oldIndex, newIndex);
  result.noOp = false;
  result.before = structuredClone(clips.slice(first, last + 1));
  let cursor = structuredClone(clips[first]!.startTime);
  result.after = reordered.slice(first, last + 1).map((clip) => {
    const moved = { ...structuredClone(clip), startTime: cursor, start: Number(cursor.value) / Number(cursor.timescale) };
    cursor = addRationalTimes(cursor, clip.durationTime, "REORDER_INVALID");
    return moved;
  });
  return result;
}

function comparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(comparable);
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length === 2 && typeof object.value === "string" && typeof object.timescale === "string") {
    const { value: numerator, timescale: denominator } = parseRational({ value: object.value, timescale: object.timescale }, "REORDER_READBACK_FAILED");
    let a = numerator < 0n ? -numerator : numerator;
    let b = denominator;
    while (b !== 0n) [a, b] = [b, a % b];
    const divisor = a || 1n;
    return { value: String(numerator / divisor), timescale: String(denominator / divisor) };
  }
  return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, comparable(child)]));
}

/** Compare the entire supported snapshot with the approved reorder projection. */
export function verifyPrimaryStorylineReorder(
  preview: PrimaryStorylineReorderPreview,
  before: ProjectSnapshot,
  after: ProjectSnapshot,
): void {
  try {
    assertReorderPreviewCurrent(preview, before);
    if (!preview.noOp && (!after.revision.id || !Number.isSafeInteger(after.revision.sequence)
      || after.revision.id === before.revision.id || after.revision.sequence <= before.revision.sequence)) {
      throw new Error("revision did not advance");
    }
    const expected = structuredClone(before);
    if (!preview.noOp) {
      const moved = new Map(preview.after.map((item) => [item.id, item]));
      expected.timeline.clips = expected.timeline.clips.map((item) => structuredClone(moved.get(item.id) ?? item));
      expected.timeline.storyElements = expected.timeline.storyElements.map((element) => {
        const updated = moved.get(element.id);
        return updated ? { ...element, start: updated.start, startTime: structuredClone(updated.startTime) } : element;
      });
      expected.revision = structuredClone(after.revision);
    }
    const actual = structuredClone(after);
    const byStart = (a: { id: string; startTime?: RationalTime }, b: { id: string; startTime?: RationalTime }): number => {
      if (!a.startTime || !b.startTime) throw new Error("exact timing unavailable");
      return compare(a.startTime, b.startTime) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    };
    expected.timeline.clips.sort(byStart);
    expected.timeline.storyElements.sort(byStart);
    actual.timeline.clips.sort(byStart);
    actual.timeline.storyElements.sort(byStart);
    if (!isDeepStrictEqual(comparable(expected), comparable(actual))) throw new Error("snapshot differs from approved reorder");
  } catch (error) {
    throw new Error("REORDER_READBACK_FAILED: complete snapshot did not match the approved reorder", { cause: error });
  }
}
