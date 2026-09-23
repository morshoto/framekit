import assert from "node:assert/strict";
import test from "node:test";
import {
  createTimelineTarget,
  type ProjectSnapshot,
} from "@framekit/runtime";
import {
  verifyCanonicalReadback,
} from "@framekit/final-cut";

function snapshot(name: string, revisionSequence = 1): ProjectSnapshot {
  return {
    projectId: "project-1",
    projectName: "Canonical verification",
    timeline: {
      id: "timeline-1",
      name: "Main",
      duration: 10,
      durationTime: { value: "240", timescale: "24" },
      frameDuration: { value: "1", timescale: "24" },
      clips: [{
        id: "clip-1",
        mediaId: "media-1",
        name,
        start: 0,
        duration: 10,
        track: 0,
        startTime: { value: "0", timescale: "24" },
        durationTime: { value: "240", timescale: "24" },
      }],
      storyElements: [{
        id: "clip-1",
        kind: "asset-clip",
        start: 0,
        duration: 10,
        startTime: { value: "0", timescale: "24" },
        durationTime: { value: "240", timescale: "24" },
        lane: 0,
        mediaId: "media-1",
      }],
      markers: [],
      captions: [],
    },
    media: [{ mediaId: "media-1", source: "clip.mov" }],
    revision: { id: `revision-${revisionSequence}`, sequence: revisionSequence, timestamp: new Date(revisionSequence).toISOString() },
  };
}

test("canonical readback verifier returns exact diff evidence for a bound target", () => {
  const before = snapshot("Original");
  const after = snapshot("Renamed", 2);
  const target = createTimelineTarget(before, { occurrenceId: "clip-1", mediaId: "media-1" });

  const evidence = verifyCanonicalReadback(before, after, target, {
    validateDiff: (diff) => {
      assert.deepEqual(diff.modified.map(({ itemId }) => itemId), ["clip-1"]);
      assert.equal(diff.modified[0]?.after?.name, "Renamed");
      assert.deepEqual(diff.markerChanges, []);
    },
  });

  assert.notEqual(evidence.beforeDigest, evidence.afterDigest);
  assert.equal(evidence.diff.to.id, after.revision.id);
});

test("canonical readback verifier rejects stale, changed, or incomplete evidence", () => {
  const before = snapshot("Original");
  const target = createTimelineTarget(before, { occurrenceId: "clip-1", mediaId: "media-1" });

  assert.throws(
    () => verifyCanonicalReadback(before, snapshot("Renamed"), target),
    /FINAL_CUT_CANONICAL_READBACK_FAILED: revision did not advance/,
  );

  const changedTimeline = snapshot("Renamed", 2);
  changedTimeline.timeline.id = "other-timeline";
  assert.throws(
    () => verifyCanonicalReadback(before, changedTimeline, target),
    /TARGET_MISMATCH: read-after-write snapshot changed the addressed timeline/,
  );

  assert.throws(
    () => verifyCanonicalReadback(before, snapshot("Renamed", 2), target, {
      validateDiff: () => { throw new Error("FINAL_CUT_CANONICAL_READBACK_FAILED: unrelated change"); },
    }),
    /FINAL_CUT_CANONICAL_READBACK_FAILED: unrelated change/,
  );
});
