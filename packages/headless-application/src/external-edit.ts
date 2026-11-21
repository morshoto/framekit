import { createHash } from "node:crypto";
import { compileTimelineIrToFcpxml } from "@framekit/final-cut/fcpxml";
import { ProjectTransactionError } from "@framekit/runtime";
import type { ContextRevision, ProjectEditCommand, RationalTime, TimelineIr, TimelineIrEditOperation, TimelineIrResource } from "@framekit/runtime";

export interface ExternalEdit {
  schemaVersion: 1;
  clips: Array<{ id: string; mediaId: string; sourceStartTime: RationalTime; durationTime: RationalTime }>;
  title?: { id: string; text: string; startTime: RationalTime; durationTime: RationalTime };
  music?: { id: string; mediaId: string; sourceStartTime: RationalTime; startTime: RationalTime; durationTime: RationalTime; gainDb: number };
}

/** Convert the bounded interchange format to the existing project transaction operations. */
export function externalEditOperations(edit: ExternalEdit, timeline: TimelineIr, expectedRevision: ContextRevision): TimelineIrEditOperation[] {
  if (timeline.revision.id !== expectedRevision.id || timeline.revision.sequence !== expectedRevision.sequence) {
    throw new ProjectTransactionError("PROJECT_EDIT_STALE_REVISION", "expected project revision does not match the inspected project", {
      expectedRevision, actualRevision: timeline.revision,
    });
  }
  const sequence = timeline.sequence;
  if (BigInt(sequence.durationTime.value) !== 0n || sequence.occurrences.length || sequence.storyElements.length
    || sequence.markers.length || sequence.captions.length || sequence.titles?.length || sequence.transitions?.length) {
    throw new Error("EXTERNAL_EDIT_INVALID: a new external edit requires an empty timeline");
  }
  const assertSource = (id: string, kind: "video" | "audio") => {
    const resource = timeline.resources.find((item) => item.id === id);
    if (!resource || resource.mediaKind !== kind || resource.sourceKind !== "local-file" || !resource.sourceDigest) {
      throw new Error(`EXTERNAL_EDIT_INVALID: ${id} is not a registered ${kind} source`);
    }
    return resource;
  };
  const frame = timeline.sequence.frameDuration;
  const aligned = (time: RationalTime, grid: RationalTime = frame, label = "sequence") => {
    const numerator = BigInt(time.value) * BigInt(grid.timescale);
    const denominator = BigInt(time.timescale) * BigInt(grid.value);
    if (denominator <= 0n || numerator % denominator !== 0n) throw new Error(`EXTERNAL_EDIT_INVALID: timing must align to the ${label} frame grid`);
  };
  for (const clip of edit.clips) {
    const resource = assertSource(clip.mediaId, "video");
    const stream = resource.metadata?.streams.find((item) => item.kind === "video");
    const rate = stream?.frameRate;
    if (!rate || BigInt(rate.value) <= 0n || BigInt(rate.timescale) <= 0n) {
      throw new Error(`EXTERNAL_EDIT_INVALID: ${clip.mediaId} has no supported source frame rate`);
    }
    if (!stream?.sourceRange) throw new Error(`EXTERNAL_EDIT_INVALID: ${clip.mediaId} has no verified video stream bounds; register the source in a new project`);
    const addRationalTimes = (a: RationalTime, b: RationalTime): RationalTime => ({ value: String(BigInt(a.value) * BigInt(b.timescale) + BigInt(b.value) * BigInt(a.timescale)), timescale: String(BigInt(a.timescale) * BigInt(b.timescale)) });
    const compare = (a: RationalTime, b: RationalTime) => BigInt(a.value) * BigInt(b.timescale) - BigInt(b.value) * BigInt(a.timescale);
    if (compare(clip.sourceStartTime, stream.sourceRange.start) < 0n || compare(addRationalTimes(clip.sourceStartTime, clip.durationTime), addRationalTimes(stream.sourceRange.start, stream.sourceRange.duration)) > 0n) {
      throw new Error(`EXTERNAL_EDIT_INVALID: ${clip.mediaId} range exceeds video stream bounds`);
    }
    const sourceFrame = { value: rate.timescale, timescale: rate.value };
    aligned(clip.sourceStartTime);
    const sourceOffset = { value: String(BigInt(clip.sourceStartTime.value) * BigInt(stream.sourceRange.start.timescale) - BigInt(stream.sourceRange.start.value) * BigInt(clip.sourceStartTime.timescale)), timescale: String(BigInt(clip.sourceStartTime.timescale) * BigInt(stream.sourceRange.start.timescale)) };
    aligned(sourceOffset, sourceFrame, "source");
    aligned(clip.durationTime);
    aligned(clip.durationTime, sourceFrame, "source");
  }
  if (edit.music) {
    if (!Number.isFinite(edit.music.gainDb) || edit.music.gainDb < -60 || edit.music.gainDb > 12) {
      throw new Error("EXTERNAL_EDIT_INVALID: music.gainDb must be between -60 and 12 dB inclusive");
    }
    const music = assertSource(edit.music.mediaId, "audio");
    verifyConnectedAudioBounds(music, edit.music.sourceStartTime, edit.music.durationTime, "EXTERNAL_EDIT_INVALID");
    for (const time of [edit.music.sourceStartTime, edit.music.startTime, edit.music.durationTime]) aligned(time);
  }
  if (edit.title) for (const time of [edit.title.startTime, edit.title.durationTime]) aligned(time);
  return [
    ...edit.clips.map((clip) => ({ type: "insert-occurrence" as const, placement: "append" as const, occurrence: {
      ...clip, name: clip.id, startTime: { value: "0", timescale: "1" }, track: 0, role: "video" as const,
    } })),
    ...(edit.music ? [{ type: "insert-occurrence" as const, occurrence: { ...edit.music, name: edit.music.id, track: 1, role: "music" as const } }] : []),
    ...(edit.title ? [{ type: "add-title" as const, title: { ...edit.title, lane: 1 } }] : []),
  ];
}

/** Reject ambiguous or unverified local connected-audio ranges before an edit is approved. */
export function verifyConnectedAudioBounds(music: TimelineIrResource, sourceStartTime: RationalTime, durationTime: RationalTime, code = "HEADLESS_AUDIO_INVALID"): void {
  const audioStreams = music.metadata?.streams.filter((stream) => stream.kind === "audio");
  if (audioStreams?.length !== 1) {
    throw new Error(`${code}: ${music.id} must have exactly one audio stream`);
  }
  const bounds = audioStreams[0]!.sourceRange;
  if (!bounds) throw new Error(`${code}: ${music.id} has no verified audio stream bounds; register a supported source in a new project`);
  const compare = (a: RationalTime, b: RationalTime) => BigInt(a.value) * BigInt(b.timescale) - BigInt(b.value) * BigInt(a.timescale);
  const add = (a: RationalTime, b: RationalTime): RationalTime => ({ value: String(BigInt(a.value) * BigInt(b.timescale) + BigInt(b.value) * BigInt(a.timescale)), timescale: String(BigInt(a.timescale) * BigInt(b.timescale)) });
  if (compare(sourceStartTime, bounds.start) < 0n || compare(add(sourceStartTime, durationTime), add(bounds.start, bounds.duration)) > 0n) {
    throw new Error(`${code}: ${music.id} range exceeds audio stream bounds`);
  }
}

/** Check the actual compiler before a JSON edit can be committed. No artifact is written. */
export function verifyExternalEditExportable(timeline: TimelineIr): void {
  compileTimelineIrToFcpxml(timeline, { target: {
    provider: "final-cut", libraryUid: "preview-library", eventUid: "preview-event",
    projectUid: "preview-project", sequenceUid: "preview-sequence", materialization: "versioned",
  } });
}

/** Bind an approved preview to its target, base revision and translated operations. */
export function externalEditPlanDigest(command: ProjectEditCommand): string {
  return createHash("sha256").update(JSON.stringify(command)).digest("hex");
}
