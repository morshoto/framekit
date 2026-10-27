import assert from "node:assert/strict";
import test from "node:test";
import { shouldConfigureFinalCutProjectPublisher } from "../../apps/mcp-server/src/final-cut-runtime-config.js";
import { createCanonicalNativeSnapshotReader } from "../../apps/mcp-server/src/canonical-native-snapshot.js";
import type { EditorLiveState, ProjectSnapshot } from "@framekit/runtime";

test("native canonical mode configures the publisher without managed FCPXML", () => {
  assert.equal(shouldConfigureFinalCutProjectPublisher({
    liveMode: true,
    fcpxmlPath: undefined,
    canonicalNativeProviderEnabled: true,
  }), true);
});

test("publisher remains disabled outside live mode or without a source route", () => {
  assert.equal(shouldConfigureFinalCutProjectPublisher({
    liveMode: false,
    fcpxmlPath: "/tmp/project.fcpxml",
    canonicalNativeProviderEnabled: true,
  }), false);
  assert.equal(shouldConfigureFinalCutProjectPublisher({
    liveMode: true,
    fcpxmlPath: undefined,
    canonicalNativeProviderEnabled: false,
  }), false);
});

test("canonical snapshot maps active native IDs without treating them as FCPXML UIDs", async () => {
  const observed: unknown[] = [];
  const live: EditorLiveState = {
    project: { id: "native-project-id", name: "Created Project" },
    sequence: {
      id: "native-sequence-id",
      name: "Main",
      startTime: { value: "0", timescale: "24" },
      duration: { value: "96", timescale: "24" },
      frameDuration: { value: "1", timescale: "24" },
    },
    revision: { id: "live-revision", sequence: 1, timestamp: new Date(0).toISOString() },
  };
  const expected = {} as ProjectSnapshot;
  const readSnapshot = createCanonicalNativeSnapshotReader(async () => live, async (target) => {
    observed.push(target);
    return expected;
  });

  assert.equal(await readSnapshot(), expected);
  assert.deepEqual(observed, [{
    projectId: "native-project-id",
    sequenceId: "native-sequence-id",
    projectName: "Created Project",
    sequenceName: "Main",
  }]);
});

test("canonical snapshot rejects synthetic live target identities", async () => {
  const live: EditorLiveState = {
    project: { id: "final-cut:project:unstable", name: "Created Project" },
    sequence: {
      id: "final-cut:sequence:unstable",
      name: "Main",
      startTime: { value: "0", timescale: "24" },
      duration: { value: "96", timescale: "24" },
      frameDuration: { value: "1", timescale: "24" },
    },
    revision: { id: "live-revision", sequence: 1, timestamp: new Date(0).toISOString() },
  };
  const readSnapshot = createCanonicalNativeSnapshotReader(async () => live, async () => {
    throw new Error("snapshot must not run without stable target IDs");
  });

  await assert.rejects(readSnapshot(), /TARGET_UNAVAILABLE: stable live project and sequence identities/);
});
