import type { Caption, Clip, Marker, ProjectSnapshot, StoryElement } from "../domain/project.js";
import type { MediaContext } from "../domain/media.js";
import type { TimeRange } from "../domain/primitives.js";
import type { TimelineDiff } from "../domain/diff.js";
import { parseRational, subtractRationalTimes } from "./rational-time.js";

function withoutId<T extends { id: string }>(value: T): Omit<T, "id"> {
  const { id: _id, ...content } = value;
  return content;
}

function rangesForClip(clip: Clip | undefined): TimeRange[] {
  return clip ? [{ start: clip.start, end: clip.start + clip.duration, startTime: clip.startTime, durationTime: clip.durationTime }] : [];
}

function diffByKey<T>(
  before: T[],
  after: T[],
  keyOf: (item: T) => string,
  comparable: (item: T) => unknown = (item) => item,
) {
  assertUniqueKeys(before, keyOf, "before");
  assertUniqueKeys(after, keyOf, "after");
  const beforeById = new Map(before.map((item) => [keyOf(item), item]));
  const afterById = new Map(after.map((item) => [keyOf(item), item]));
  return {
    added: [...afterById.values()].filter((item) => !beforeById.has(keyOf(item))),
    removed: [...beforeById.values()].filter((item) => !afterById.has(keyOf(item))),
    modified: [...afterById.values()].filter((item) => {
      const previous = beforeById.get(keyOf(item));
      return previous !== undefined && stableJson(comparable(previous)) !== stableJson(comparable(item));
    }).map((afterItem) => ({ after: afterItem, before: beforeById.get(keyOf(afterItem))! })),
  };
}

function diffById<T extends { id: string }>(before: T[], after: T[]) {
  return diffByKey(before, after, (item) => item.id, withoutId);
}

function mediaRegistryFields(media: MediaContext) {
  return {
    source: media.source,
    mediaKind: media.mediaKind,
    duration: media.duration,
    sourceDigest: media.sourceDigest,
  };
}

export function diffSnapshots(before: ProjectSnapshot, after: ProjectSnapshot): TimelineDiff {
  if (before.projectId !== after.projectId || before.timeline.id !== after.timeline.id) {
    throw new Error("TARGET_MISMATCH: cannot diff snapshots from different project or sequence targets");
  }

  const clips = diffById(before.timeline.clips, after.timeline.clips);
  const added = clips.added.map((clip) => ({ type: "ITEM_ADDED" as const, itemId: clip.id, after: clip }));
  const removed = clips.removed.map((clip) => ({ type: "ITEM_REMOVED" as const, itemId: clip.id, before: clip }));
  const modified = clips.modified.map(({ before: previous, after: current }) => ({
    type: "ITEM_MODIFIED" as const,
    itemId: current.id,
    before: previous,
    after: current,
  }));

  const markers = diffById(before.timeline.markers, after.timeline.markers);
  const markerChanges: TimelineDiff["markerChanges"] = [
    ...markers.added.map((marker) => ({ type: "MARKER_ADDED" as const, itemId: marker.id, marker, after: marker })),
    ...markers.removed.map((marker) => ({ type: "MARKER_REMOVED" as const, itemId: marker.id, marker, before: marker })),
    ...markers.modified.map(({ before: previous, after: current }) => ({
      type: "MARKER_MODIFIED" as const,
      itemId: current.id,
      marker: current,
      before: previous,
      after: current,
    })),
  ];

  const captions = diffById(before.timeline.captions, after.timeline.captions);
  const captionChanges: TimelineDiff["captionChanges"] = [
    ...captions.added.map((caption) => ({ type: "CAPTION_ADDED" as const, itemId: caption.id, caption, after: caption })),
    ...captions.removed.map((caption) => ({ type: "CAPTION_REMOVED" as const, itemId: caption.id, caption, before: caption })),
    ...captions.modified.map(({ before: previous, after: current }) => ({
      type: "CAPTION_MODIFIED" as const,
      itemId: current.id,
      caption: current,
      before: previous,
      after: current,
    })),
  ];

  const storyElements = diffById(before.timeline.storyElements, after.timeline.storyElements);
  const storyElementChanges: TimelineDiff["storyElementChanges"] = [
    ...storyElements.added.map((element) => ({ type: "STORY_ELEMENT_ADDED" as const, itemId: element.id, element, after: element })),
    ...storyElements.removed.map((element) => ({ type: "STORY_ELEMENT_REMOVED" as const, itemId: element.id, element, before: element })),
    ...storyElements.modified.map(({ before: previous, after: current }) => ({
      type: "STORY_ELEMENT_MODIFIED" as const,
      itemId: current.id,
      element: current,
      before: previous,
      after: current,
    })),
  ];

  const media = diffByKey(before.media, after.media, (item) => item.mediaId, mediaRegistryFields);
  const mediaChanges: TimelineDiff["mediaChanges"] = [
    ...media.added.map((item) => ({ type: "MEDIA_ADDED" as const, itemId: item.mediaId, media: item, after: item })),
    ...media.removed.map((item) => ({ type: "MEDIA_REMOVED" as const, itemId: item.mediaId, media: item, before: item })),
    ...media.modified.map(({ before: previous, after: current }) => ({
      type: "MEDIA_MODIFIED" as const,
      itemId: current.mediaId,
      media: current,
      before: previous,
      after: current,
    })),
  ];

  const affectedRanges = uniqueRanges([
    ...added.flatMap((change) => rangesForClip(change.after)),
    ...removed.flatMap((change) => rangesForClip(change.before)),
    ...modified.flatMap((change) => [...rangesForClip(change.before), ...rangesForClip(change.after)]),
    ...markerChanges.flatMap(({ marker, before: previous }) => [{
      start: previous?.start ?? marker.start,
      end: Math.max(previous ? previous.start + previous.duration : 0, marker.start + marker.duration),
      startTime: previous?.startTime ?? marker.startTime,
      durationTime: previous?.durationTime ?? marker.durationTime,
    }]),
    ...captionChanges.flatMap(({ caption, before: previous }) => [{
      start: previous?.start ?? caption.start,
      end: Math.max(previous ? previous.start + previous.duration : 0, caption.start + caption.duration),
      startTime: previous?.startTime ?? caption.startTime,
      durationTime: previous?.durationTime ?? caption.durationTime,
    }]),
    ...storyElementChanges.flatMap(({ element, before: previous }) => [{
      start: previous?.start ?? element.start,
      end: Math.max(previous ? previous.start + previous.duration : 0, element.start + element.duration),
    }]),
  ]);

  const playheadChange = !sameRationalTime(before.playheadTime, after.playheadTime)
    ? {
        ...(before.playheadTime ? { before: { ...before.playheadTime } } : {}),
        ...(after.playheadTime ? { after: { ...after.playheadTime } } : {}),
      }
    : undefined;

  return {
    from: before.revision,
    to: after.revision,
    provenance: {
      source: "project-snapshot",
      projectId: before.projectId,
      sequenceId: before.timeline.id,
      fromRevision: before.revision,
      toRevision: after.revision,
    },
    added,
    removed,
    modified,
    durationDelta: after.timeline.duration - before.timeline.duration,
    durationDeltaTime: subtractRationalTimes(
      after.timeline.durationTime ?? decimalToRational(after.timeline.duration),
      before.timeline.durationTime ?? decimalToRational(before.timeline.duration),
      "INVALID_PROJECT_STATE",
    ),
    ...(playheadChange ? { playheadChange } : {}),
    markerChanges,
    captionChanges,
    storyElementChanges,
    mediaChanges,
    affectedRanges,
  };
}

function assertUniqueKeys<T>(items: T[], keyOf: (item: T) => string, side: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) throw new Error(`AMBIGUOUS_TIMELINE_IDENTITY: duplicate ${side} item ${key}`);
    seen.add(key);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return value === undefined ? "undefined" : JSON.stringify(value);
}

function sameRationalTime(left: ProjectSnapshot["playheadTime"], right: ProjectSnapshot["playheadTime"]): boolean {
  if (!left || !right) return left === right;
  try {
    const leftParts = parseRational(left, "INVALID_PROJECT_STATE");
    const rightParts = parseRational(right, "INVALID_PROJECT_STATE");
    return leftParts.value * rightParts.timescale === rightParts.value * leftParts.timescale;
  } catch {
    return stableJson(left) === stableJson(right);
  }
}

function uniqueRanges(ranges: TimeRange[]): TimeRange[] {
  const seen = new Set<string>();
  return ranges.filter((range) => {
    const key = [
      range.start,
      range.end,
      range.startTime?.value ?? "",
      range.startTime?.timescale ?? "",
      range.durationTime?.value ?? "",
      range.durationTime?.timescale ?? "",
    ].join("/");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function decimalToRational(value: number) {
  const text = value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  if (!text.includes(".")) return { value: text || "0", timescale: "1" };
  const decimals = text.split(".")[1].length;
  const scale = 10 ** decimals;
  return { value: String(Math.round(value * scale)), timescale: String(scale) };
}
