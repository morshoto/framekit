import type {
  Caption,
  Clip,
  Marker,
  ProjectSnapshot,
  StoryElement,
  TimeRange,
  TimelineDiff,
} from "./types.js";

function withoutId<T extends { id: string }>(value: T): Omit<T, "id"> {
  const { id: _id, ...content } = value;
  return content;
}

function rangesForClip(clip: Clip | undefined): TimeRange[] {
  return clip ? [{ start: clip.start, end: clip.start + clip.duration, startTime: clip.startTime, durationTime: clip.durationTime }] : [];
}

function diffById<T extends { id: string }>(before: T[], after: T[]) {
  const beforeById = new Map(before.map((item) => [item.id, item]));
  const afterById = new Map(after.map((item) => [item.id, item]));
  return {
    added: [...afterById.values()].filter((item) => !beforeById.has(item.id)),
    removed: [...beforeById.values()].filter((item) => !afterById.has(item.id)),
    modified: [...afterById.values()].filter((item) => {
      const previous = beforeById.get(item.id);
      return previous !== undefined && JSON.stringify(withoutId(previous)) !== JSON.stringify(withoutId(item));
    }).map((afterItem) => ({ after: afterItem, before: beforeById.get(afterItem.id)! })),
  };
}

export function diffSnapshots(before: ProjectSnapshot, after: ProjectSnapshot): TimelineDiff {
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
    ...markers.added.map((marker) => ({ type: "MARKER_ADDED" as const, marker })),
    ...markers.removed.map((marker) => ({ type: "MARKER_REMOVED" as const, marker })),
    ...markers.modified.map(({ before: previous, after: current }) => ({
      type: "MARKER_MODIFIED" as const,
      marker: current,
      before: previous,
      after: current,
    })),
  ];

  const captions = diffById(before.timeline.captions, after.timeline.captions);
  const captionChanges: TimelineDiff["captionChanges"] = [
    ...captions.added.map((caption) => ({ type: "CAPTION_ADDED" as const, caption })),
    ...captions.removed.map((caption) => ({ type: "CAPTION_REMOVED" as const, caption })),
    ...captions.modified.map(({ before: previous, after: current }) => ({
      type: "CAPTION_MODIFIED" as const,
      caption: current,
      before: previous,
      after: current,
    })),
  ];

  const storyElements = diffById(before.timeline.storyElements, after.timeline.storyElements);
  const storyElementChanges: TimelineDiff["storyElementChanges"] = [
    ...storyElements.added.map((element) => ({ type: "STORY_ELEMENT_ADDED" as const, element, after: element })),
    ...storyElements.removed.map((element) => ({ type: "STORY_ELEMENT_REMOVED" as const, element, before: element })),
    ...storyElements.modified.map(({ before: previous, after: current }) => ({
      type: "STORY_ELEMENT_MODIFIED" as const,
      element: current,
      before: previous,
      after: current,
    })),
  ];

  const affectedRanges = [
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
  ];

  return {
    from: before.revision,
    to: after.revision,
    added,
    removed,
    modified,
    durationDelta: after.timeline.duration - before.timeline.duration,
    durationDeltaTime: decimalToRational(after.timeline.duration - before.timeline.duration),
    markerChanges,
    captionChanges,
    storyElementChanges,
    affectedRanges,
  };
}

function decimalToRational(value: number) {
  const text = value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  if (!text.includes(".")) return { value: text || "0", timescale: "1" };
  const decimals = text.split(".")[1].length;
  const scale = 10 ** decimals;
  return { value: String(Math.round(value * scale)), timescale: String(scale) };
}
