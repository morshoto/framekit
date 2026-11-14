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
  occurrenceId: string;
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

/** Plan a contiguous primary-storyline reorder without dispatching an editor operation. */
export function previewPrimaryStorylineReorder(
  snapshot: ProjectSnapshot,
  occurrenceId: string,
  destination: PrimaryStorylineDestination,
): PrimaryStorylineReorderPreview {
  if (!snapshot.projectId || !snapshot.timeline.id || !snapshot.revision.id) throw new Error("REORDER_INVALID: target and revision are required");
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
    if (compare(clip.durationTime, { value: "0", timescale: "1" }) <= 0) throw new Error("REORDER_INVALID: duration must be positive");
    if (index > 0 && compare(addRationalTimes(clips[index - 1]!.startTime, clips[index - 1]!.durationTime), clip.startTime) !== 0) {
      throw new Error("REORDER_UNSUPPORTED: primary storyline is not contiguous");
    }
  }
  const oldIndex = clips.findIndex((clip) => clip.id === occurrenceId);
  if (oldIndex < 0) throw new Error("REORDER_TARGET_NOT_FOUND: moving occurrence is missing");
  if ((destination.kind === "before" || destination.kind === "after") && !ids.has(destination.occurrenceId)) {
    throw new Error("REORDER_TARGET_NOT_FOUND: destination occurrence is missing");
  }
  const result: PrimaryStorylineReorderPreview = { projectId: snapshot.projectId, sequenceId: snapshot.timeline.id, revision: structuredClone(snapshot.revision), occurrenceId, destination: structuredClone(destination), noOp: true, before: [], after: [] };
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
