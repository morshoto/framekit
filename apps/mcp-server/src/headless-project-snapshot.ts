import type { ProjectSnapshot, TimelineIr } from "@framekit/runtime";

/** Adapt the persisted headless Timeline IR to the runtime's analysis contract. */
export function projectSnapshotFromTimelineIr(timeline: TimelineIr): ProjectSnapshot {
  const occurrences = timeline.sequence.occurrences;
  const seconds = (time: { value: string; timescale: string }): number => {
    const value = Number(time.value) / Number(time.timescale);
    if (!Number.isFinite(value)) throw new Error("HEADLESS_TIMELINE_INVALID: rational time is outside the supported range");
    return value;
  };
  const stories: ProjectSnapshot["timeline"]["storyElements"] = timeline.sequence.storyElements.map((element) => {
    const occurrence = occurrences.find((candidate) => candidate.id === element.occurrenceId);
    return {
      id: element.id,
      kind: element.kind,
      start: seconds(element.startTime),
      duration: seconds(element.durationTime),
      startTime: structuredClone(element.startTime),
      durationTime: structuredClone(element.durationTime),
      ...(element.lane !== undefined ? { lane: element.lane } : {}),
      ...(occurrence?.mediaId ? { mediaId: occurrence.mediaId } : {}),
      ...(element.text !== undefined ? { text: element.text } : {}),
      ...(element.attachedTo ? { attachedTo: element.attachedTo } : {}),
    };
  });
  for (const title of timeline.sequence.titles ?? []) {
    stories.push({
      id: title.id,
      kind: "title",
      start: seconds(title.startTime),
      duration: seconds(title.durationTime),
      startTime: structuredClone(title.startTime),
      durationTime: structuredClone(title.durationTime),
      lane: title.lane,
      text: title.text,
    });
  }

  return {
    projectId: timeline.project.id,
    projectName: timeline.project.name,
    timeline: {
      id: timeline.sequence.id,
      name: timeline.sequence.name,
      duration: seconds(timeline.sequence.durationTime),
      durationTime: structuredClone(timeline.sequence.durationTime),
      frameDuration: structuredClone(timeline.sequence.frameDuration),
      clips: occurrences.map((occurrence) => ({
        id: occurrence.id,
        ...(occurrence.mediaId ? { mediaId: occurrence.mediaId } : {}),
        name: occurrence.name,
        start: seconds(occurrence.startTime),
        duration: seconds(occurrence.durationTime),
        ...(occurrence.sourceStartTime ? {
          sourceStart: seconds(occurrence.sourceStartTime),
          sourceStartTime: structuredClone(occurrence.sourceStartTime),
        } : {}),
        track: occurrence.track,
        ...(occurrence.gainDb !== undefined ? { gainDb: occurrence.gainDb } : {}),
        ...(occurrence.fadeIn !== undefined ? { fadeIn: occurrence.fadeIn } : {}),
        ...(occurrence.fadeOut !== undefined ? { fadeOut: occurrence.fadeOut } : {}),
        ...(occurrence.enabled !== undefined ? { enabled: occurrence.enabled } : {}),
        ...(occurrence.role ? { role: occurrence.role } : {}),
        ...(occurrence.attachedTo ? { attachedTo: occurrence.attachedTo } : {}),
        startTime: structuredClone(occurrence.startTime),
        durationTime: structuredClone(occurrence.durationTime),
      })),
      storyElements: stories,
      markers: timeline.sequence.markers.map((marker) => ({
        id: marker.id,
        name: marker.name,
        start: seconds(marker.startTime),
        duration: seconds(marker.durationTime),
        startTime: structuredClone(marker.startTime),
        durationTime: structuredClone(marker.durationTime),
      })),
      captions: timeline.sequence.captions.map((caption) => ({
        id: caption.id,
        text: caption.text,
        start: seconds(caption.startTime),
        duration: seconds(caption.durationTime),
        startTime: structuredClone(caption.startTime),
        durationTime: structuredClone(caption.durationTime),
      })),
    },
    media: timeline.resources.flatMap((resource) => {
      if (!resource.source) return [];
      const mediaKind = resource.mediaKind === "audio" || resource.mediaKind === "video"
        ? resource.mediaKind
        : undefined;
      const durationTime = resource.metadata?.durationTime;
      return [{
        mediaId: resource.id,
        source: resource.source,
        ...(mediaKind ? { mediaKind } : {}),
        ...(resource.sourceDigest ? { sourceDigest: resource.sourceDigest } : {}),
        ...(durationTime ? { duration: seconds(durationTime) } : {}),
      }];
    }),
    revision: structuredClone(timeline.revision),
  };
}
