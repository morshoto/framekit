import type { Clip, ProjectSnapshot, TimelineDiff } from "./types.js";

function clipContent(clip: Clip): Omit<Clip, "id"> {
  const { id: _id, ...content } = clip;
  return content;
}

export function diffSnapshots(before: ProjectSnapshot, after: ProjectSnapshot): TimelineDiff {
  const beforeClips = new Map(before.timeline.clips.map((clip) => [clip.id, clip]));
  const afterClips = new Map(after.timeline.clips.map((clip) => [clip.id, clip]));
  const added = [...afterClips.values()]
    .filter((clip) => !beforeClips.has(clip.id))
    .map((afterClip) => ({ type: "ITEM_ADDED" as const, itemId: afterClip.id, after: afterClip }));
  const removed = [...beforeClips.values()]
    .filter((clip) => !afterClips.has(clip.id))
    .map((beforeClip) => ({ type: "ITEM_REMOVED" as const, itemId: beforeClip.id, before: beforeClip }));
  const modified = [...afterClips.values()]
    .filter((afterClip) => {
      const beforeClip = beforeClips.get(afterClip.id);
      return beforeClip !== undefined && JSON.stringify(clipContent(beforeClip)) !== JSON.stringify(clipContent(afterClip));
    })
    .map((afterClip) => ({
      type: "ITEM_MODIFIED" as const,
      itemId: afterClip.id,
      before: beforeClips.get(afterClip.id),
      after: afterClip,
    }));

  const beforeDuration = before.timeline.clips.reduce((total, clip) => total + clip.duration, 0);
  const afterDuration = after.timeline.clips.reduce((total, clip) => total + clip.duration, 0);
  const beforeMarkers = new Map(before.timeline.markers.map((marker) => [marker.id, marker]));
  const afterMarkers = new Map(after.timeline.markers.map((marker) => [marker.id, marker]));
  const markerChanges = [
    ...[...afterMarkers.values()]
      .filter((marker) => !beforeMarkers.has(marker.id))
      .map((marker) => ({ type: "MARKER_ADDED" as const, marker })),
    ...[...beforeMarkers.values()]
      .filter((marker) => !afterMarkers.has(marker.id))
      .map((marker) => ({ type: "MARKER_REMOVED" as const, marker })),
  ];
  const affectedRanges = modified.flatMap((change) => {
    const clip = change.after ?? change.before;
    return clip ? [{ start: clip.start, end: clip.start + clip.duration }] : [];
  });
  affectedRanges.push(...markerChanges.map(({ marker }) => ({
    start: marker.start,
    end: marker.start + marker.duration,
  })));

  return {
    from: before.revision,
    to: after.revision,
    added,
    removed,
    modified,
    durationDelta: afterDuration - beforeDuration,
    markerChanges,
    affectedRanges,
  };
}
