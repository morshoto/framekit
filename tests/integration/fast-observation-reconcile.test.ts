import assert from "node:assert/strict";
import test from "node:test";
import {
  reconcileFastTimelineObservation,
  timelineIrDigest,
  type FastTimelineObservation,
  type TimelineIr,
} from "@framekit/runtime";

function timeline(): TimelineIr {
  return {
    schemaVersion: 1,
    project: { id: "project-1", name: "Project" },
    sequence: {
      id: "sequence-1",
      name: "Main",
      durationTime: { value: "120", timescale: "30" },
      frameDuration: { value: "1", timescale: "30" },
      occurrences: [{
        id: "occurrence-1",
        name: "Opening",
        startTime: { value: "0", timescale: "30" },
        durationTime: { value: "90", timescale: "30" },
        track: 0,
        role: "video",
        mediaId: "media-1",
      }],
      storyElements: [],
      markers: [],
      captions: [],
    },
    resources: [{ id: "media-1", name: "opening.mov", mediaKind: "video", source: "/media/opening.mov" }],
    revision: { id: "revision-1", sequence: 1, timestamp: "2026-09-26T00:00:00.000Z" },
  };
}

function observation(value: TimelineIr, coverage: FastTimelineObservation["coverage"] = completeCoverage()): FastTimelineObservation {
  return {
    provider: "final-cut-pasteboard",
    canonical: false,
    target: { projectId: value.project.id, sequenceId: value.sequence.id },
    revision: value.revision,
    timelineDigest: timelineIrDigest(value),
    coverage,
    timeline: value,
  };
}

function completeCoverage(): FastTimelineObservation["coverage"] {
  return {
    occurrences: "complete",
    resources: "complete",
    timing: "complete",
    roles: "complete",
    storylineRelationships: "complete",
    markersCaptions: "complete",
  };
}

test("fast observations distinguish unchanged and expected Framekit edits", () => {
  const base = timeline();
  const desired = structuredClone(base);
  desired.sequence.occurrences[0]!.name = "Opening revised";

  assert.equal(reconcileFastTimelineObservation({ base, desired, observation: observation(base) }).status, "unchanged");
  assert.equal(reconcileFastTimelineObservation({
    base,
    desired,
    observation: observation({ ...desired, revision: { id: "revision-2", sequence: 2, timestamp: "2026-09-26T00:01:00.000Z" } }),
  }).status, "advanced-by-framekit");
});

test("fast observations escalate incomplete evidence without canonical promotion", () => {
  const base = timeline();
  const result = reconcileFastTimelineObservation({
    base,
    desired: base,
    observation: observation(base, { ...completeCoverage(), occurrences: "partial" }),
  });

  assert.equal(result.status, "canonical-resync-required");
  assert.equal(result.canonical, false);
  assert.match(result.reason, /incomplete coverage/);
});

test("fast observations surface target and external-edit conflicts", () => {
  const base = timeline();
  const wrongTarget = observation(base);
  wrongTarget.target.projectId = "other-project";
  assert.equal(reconcileFastTimelineObservation({ base, desired: base, observation: wrongTarget }).status, "canonical-resync-required");

  const desired = structuredClone(base);
  desired.sequence.occurrences[0]!.name = "Agent rename";
  const provider = structuredClone(base);
  provider.sequence.occurrences[0]!.name = "Manual rename";
  const result = reconcileFastTimelineObservation({ base, desired, observation: observation(provider) });
  assert.equal(result.status, "conflicted");
  assert.equal(result.canonical, false);
});
