import assert from "node:assert/strict";
import test from "node:test";
import { assessCanonicalLiveReadiness } from "@framekit/final-cut";
import type { RuntimeCapabilities } from "@framekit/runtime";

const canonicalWrite: RuntimeCapabilities = {
  editor: {
    projectRead: true,
    timelineSnapshotRead: true,
    timelineWrite: true,
    timelineArtifactWrite: false,
    readAfterWrite: true,
    incrementalChanges: true,
    rollback: true,
    assetDiscovery: false,
    liveStateRead: true,
    playheadWrite: false,
    frameCapture: false,
    projectCatalogRead: true,
    projectSelection: true,
  },
  analyzers: {
    speechTranscribe: false,
    speechVad: false,
    audioLoudness: false,
    visualTrack: false,
  },
};

test("canonical provider readiness accepts complete live read/write guarantees", () => {
  assert.deepEqual(assessCanonicalLiveReadiness(canonicalWrite), {
    ready: true,
    mode: "canonical-write",
    missing: [],
  });
});

test("canonical provider readiness identifies metadata-only and missing target guarantees", () => {
  const readiness = assessCanonicalLiveReadiness({
    ...canonicalWrite,
    editor: {
      ...canonicalWrite.editor,
      canonicalTimelineMode: "metadata-only",
      timelineSnapshotRead: false,
      timelineWrite: false,
      readAfterWrite: false,
      rollback: false,
      projectCatalogRead: false,
      projectSelection: false,
    },
  });

  assert.equal(readiness.ready, false);
  assert.equal(readiness.mode, "metadata-only");
  assert.deepEqual(readiness.missing, [
    "canonical-write",
    "projectCatalogRead",
    "projectSelection",
    "timelineSnapshotRead",
    "timelineWrite",
    "readAfterWrite",
    "rollback",
  ]);
});
