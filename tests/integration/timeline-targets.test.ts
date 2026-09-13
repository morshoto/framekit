import assert from "node:assert/strict";
import test from "node:test";
import {
  assertTimelineTargetReadAfterWrite,
  createTimelineTarget,
  resolveTimelineTarget,
  type ProjectSnapshot,
  type TimelineTarget,
} from "@framekit/runtime";

function revision(sequence = 0) {
  return {
    id: `revision-${sequence}`,
    sequence,
    timestamp: new Date(sequence).toISOString(),
  };
}

function snapshot(overrides: Partial<ProjectSnapshot["timeline"]> = {}): ProjectSnapshot {
  const clip = {
    id: "occurrence-1",
    mediaId: "media-1",
    name: "Interview",
    start: 0.5,
    duration: 2,
    track: 0,
    startTime: { value: "12", timescale: "24" },
    durationTime: { value: "48", timescale: "24" },
  };
  return {
    projectId: "project-1",
    projectName: "Interview",
    timeline: {
      id: "sequence-1",
      name: "Main Edit",
      duration: 4,
      durationTime: { value: "96", timescale: "24" },
      frameDuration: { value: "1", timescale: "24" },
      clips: [clip],
      storyElements: [{
        id: clip.id,
        kind: "asset-clip",
        start: clip.start,
        duration: clip.duration,
        startTime: clip.startTime,
        durationTime: clip.durationTime,
        lane: clip.track,
        mediaId: clip.mediaId,
      }],
      markers: [],
      captions: [],
      ...overrides,
    },
    media: [{ mediaId: "media-1", source: "/media/interview.mov", mediaKind: "video" }],
    revision: revision(),
  };
}

function targetFor(project: ProjectSnapshot): TimelineTarget {
  return createTimelineTarget(project, {
    occurrenceId: "occurrence-1",
    mediaId: "media-1",
    range: {
      start: { value: "0", timescale: "24" },
      end: { value: "96", timescale: "24" },
    },
  });
}

test("stable targets carry scope, revision, media, occurrence, and exact coordinates", () => {
  const project = snapshot();
  const target = targetFor(project);

  assert.deepEqual(target, {
    projectId: "project-1",
    sequenceId: "sequence-1",
    revision: project.revision,
    timelineStartTime: { value: "0", timescale: "1" },
    frameDuration: { value: "1", timescale: "24" },
    mediaId: "media-1",
    occurrence: {
      id: "occurrence-1",
      mediaId: "media-1",
      startTime: { value: "12", timescale: "24" },
      durationTime: { value: "48", timescale: "24" },
    },
    range: {
      start: { value: "0", timescale: "24" },
      end: { value: "96", timescale: "24" },
    },
  });

  const equivalentCoordinates = structuredClone(target);
  equivalentCoordinates.occurrence!.startTime = { value: "1", timescale: "2" };
  equivalentCoordinates.occurrence!.durationTime = { value: "2", timescale: "1" };
  const resolved = resolveTimelineTarget(project, equivalentCoordinates);
  assert.equal(resolved.occurrence?.id, "occurrence-1");
});

test("stable target resolution rejects duplicate occurrence identities", () => {
  const project = snapshot({
    clips: [
      projectClip("occurrence-1", 0),
      projectClip("occurrence-1", 2),
    ],
  });
  const target = targetFor(snapshot());

  assertRejects(() => resolveTimelineTarget(project, target), /AMBIGUOUS_TIMELINE_TARGET/);
});

test("stable target resolution rejects stale scope and revision", () => {
  const project = snapshot();
  const target = targetFor(project);

  assertRejects(
    () => resolveTimelineTarget({ ...project, revision: revision(1) }, target),
    /STALE_CONTEXT/,
  );
  assertRejects(
    () => resolveTimelineTarget(project, { ...target, projectId: "other-project" }),
    /TARGET_MISMATCH/,
  );
});

test("stable target construction rejects ranges that are not frame aligned", () => {
  const project = snapshot();

  assertRejects(
    () => createTimelineTarget(project, {
      range: {
        start: { value: "1", timescale: "48" },
        end: { value: "5", timescale: "48" },
      },
    }),
    /FRAME_ALIGNMENT_REQUIRED/,
  );
});

test("read-after-write accepts coordinate changes but rejects identity drift", () => {
  const before = snapshot();
  const target = targetFor(before);
  const moved = projectClip("occurrence-1", 1.5);
  const after = {
    ...before,
    revision: revision(1),
    timeline: {
      ...before.timeline,
      clips: [moved],
    },
  };

  assertTimelineTargetReadAfterWrite(target, before, after);
  assertRejects(
    () => assertTimelineTargetReadAfterWrite(target, before, {
      ...after,
      timeline: { ...after.timeline, clips: [{ ...moved, mediaId: "media-other" }] },
    }),
    /TARGET_MISMATCH/,
  );
});

function projectClip(id: string, start: number) {
  return {
    id,
    mediaId: "media-1",
    name: "Interview",
    start,
    duration: 2,
    track: 0,
    startTime: { value: String(Math.round(start * 24)), timescale: "24" },
    durationTime: { value: "48", timescale: "24" },
  };
}

function assertRejects(action: () => unknown, pattern: RegExp): void {
  assert.throws(action, pattern);
}
