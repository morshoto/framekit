import assert from "node:assert/strict";
import test from "node:test";
import {
  createTimelineTarget,
  type ProjectSnapshot,
} from "@framekit/runtime";
import {
  recoverCanonicalNativeMutation,
} from "@framekit/final-cut";

function snapshot(name: string, revisionSequence = 1): ProjectSnapshot {
  return {
    projectId: "project-1",
    projectName: "Canonical recovery",
    timeline: {
      id: "timeline-1",
      name: "Main",
      duration: 4,
      durationTime: { value: "96", timescale: "24" },
      frameDuration: { value: "1", timescale: "24" },
      clips: [{
        id: "clip-1",
        mediaId: "media-1",
        name,
        start: 0,
        duration: 4,
        track: 0,
        startTime: { value: "0", timescale: "24" },
        durationTime: { value: "96", timescale: "24" },
      }],
      storyElements: [{
        id: "clip-1",
        kind: "asset-clip",
        start: 0,
        duration: 4,
        startTime: { value: "0", timescale: "24" },
        durationTime: { value: "96", timescale: "24" },
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

test("canonical recovery verifies native Undo and restores the bound digest", async () => {
  const before = snapshot("Original");
  const restored = snapshot("Original", 3);
  const target = createTimelineTarget(before, { occurrenceId: "clip-1", mediaId: "media-1" });
  const calls: string[] = [];

  const result = await recoverCanonicalNativeMutation({
    operationId: "native-operation-1",
    before,
    target,
    undo: async (operationId) => {
      calls.push(`undo:${operationId}`);
      return { undone: true, verification: { verified: true } };
    },
    readSnapshot: async () => restored,
  });

  assert.deepEqual(calls, ["undo:native-operation-1"]);
  assert.equal(result.succeeded, true);
  assert.equal(result.restoredDigest, result.beforeDigest);
});

test("canonical recovery fails closed for unverified Undo or mismatched restoration", async () => {
  const before = snapshot("Original");
  const target = createTimelineTarget(before, { occurrenceId: "clip-1", mediaId: "media-1" });

  await assert.rejects(
    recoverCanonicalNativeMutation({
      operationId: "native-operation-1",
      before,
      target,
      undo: async () => ({ undone: false, verification: { verified: false } }),
      readSnapshot: async () => snapshot("Original", 2),
    }),
    /FINAL_CUT_CANONICAL_ROLLBACK_FAILED: native Undo did not verify restoration/,
  );

  await assert.rejects(
    recoverCanonicalNativeMutation({
      operationId: "native-operation-1",
      before,
      target,
      undo: async () => ({ undone: true, verification: { verified: true } }),
      readSnapshot: async () => snapshot("Different", 2),
    }),
    /FINAL_CUT_CANONICAL_ROLLBACK_FAILED: restored canonical digest does not match the pre-edit state/,
  );
});
