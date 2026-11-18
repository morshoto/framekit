import { compileTimelineIrToFcpxml } from "@framekit/final-cut/fcpxml";
import type { RationalTime, TimelineIr, TimelineIrEditOperation } from "@framekit/runtime";

export interface ExternalEdit {
  schemaVersion: 1;
  clips: Array<{ id: string; mediaId: string; sourceStartTime: RationalTime; durationTime: RationalTime }>;
  title: { id: string; text: string; startTime: RationalTime; durationTime: RationalTime };
  music: { id: string; mediaId: string; sourceStartTime: RationalTime; startTime: RationalTime; durationTime: RationalTime; gainDb: number };
}

/** Convert the bounded interchange format to the existing project transaction operations. */
export function externalEditOperations(edit: ExternalEdit, timeline: TimelineIr): TimelineIrEditOperation[] {
  const assertSource = (id: string, kind: "video" | "audio") => {
    const resource = timeline.resources.find((item) => item.id === id);
    if (!resource || resource.mediaKind !== kind || resource.sourceKind !== "local-file" || !resource.sourceDigest) {
      throw new Error(`EXTERNAL_EDIT_INVALID: ${id} is not a registered ${kind} source`);
    }
  };
  const frame = timeline.sequence.frameDuration;
  const aligned = (time: RationalTime) => {
    const numerator = BigInt(time.value) * BigInt(frame.timescale);
    const denominator = BigInt(time.timescale) * BigInt(frame.value);
    if (denominator <= 0n || numerator % denominator !== 0n) throw new Error("EXTERNAL_EDIT_INVALID: timing must align to the sequence frame grid");
  };
  for (const clip of edit.clips) {
    assertSource(clip.mediaId, "video");
    aligned(clip.sourceStartTime);
    aligned(clip.durationTime);
  }
  assertSource(edit.music.mediaId, "audio");
  for (const time of [edit.music.sourceStartTime, edit.music.startTime, edit.music.durationTime, edit.title.startTime, edit.title.durationTime]) aligned(time);
  return [
    ...edit.clips.map((clip) => ({ type: "insert-occurrence" as const, placement: "append" as const, occurrence: {
      ...clip, name: clip.id, startTime: { value: "0", timescale: "1" }, track: 0, role: "video" as const,
    } })),
    { type: "insert-occurrence", occurrence: { ...edit.music, name: edit.music.id, track: 1, role: "music" } },
    { type: "add-title", title: { ...edit.title, lane: 1 } },
  ];
}

/** Check the actual compiler before a JSON edit can be committed. No artifact is written. */
export function verifyExternalEditExportable(timeline: TimelineIr): void {
  compileTimelineIrToFcpxml(timeline, { target: {
    provider: "final-cut", libraryUid: "preview-library", eventUid: "preview-event",
    projectUid: "preview-project", sequenceUid: "preview-sequence", materialization: "versioned",
  } });
}
