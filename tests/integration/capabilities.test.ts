import assert from "node:assert/strict";
import test from "node:test";
import { withCapabilityFamilies } from "@framekit/runtime";

const metadataOnlyCapabilities = {
  editor: {
    projectRead: true,
    timelineSnapshotRead: false,
    timelineWrite: false,
    timelineArtifactWrite: false,
    readAfterWrite: false,
    incrementalChanges: true,
    rollback: false,
    assetDiscovery: false,
    liveStateRead: true,
    playheadWrite: false,
    frameCapture: false,
  },
  analyzers: {
    speechTranscribe: false,
    speechVad: false,
    audioLoudness: false,
    visualTrack: false,
  },
};

const artifactCapabilities = {
  editor: {
    ...metadataOnlyCapabilities.editor,
    timelineSnapshotRead: true,
    timelineArtifactWrite: true,
    readAfterWrite: true,
    rollback: true,
    projectCatalogRead: true,
    projectSelection: true,
  },
  analyzers: metadataOnlyCapabilities.analyzers,
};

test("capability families expose versioned canonical and observation operations", () => {
  const capabilities = withCapabilityFamilies(artifactCapabilities, { backend: "fcpxml-document" });

  assert.equal(capabilities.schemaVersion, 1);
  assert.deepEqual(capabilities.families.observation.timeline, {
    available: true,
    backend: "fcpxml-document",
    guarantee: "canonical-read",
  });
  assert.deepEqual(capabilities.families.canonicalDocument.read, {
    available: true,
    backend: "fcpxml-document",
    guarantee: "canonical-read",
  });
  assert.deepEqual(capabilities.families.canonicalDocument.artifactWrite, {
    available: true,
    backend: "fcpxml-document",
    guarantee: "artifact-write",
  });
});

test("unavailable capability operations explain their fail-closed reason", () => {
  const capabilities = withCapabilityFamilies(metadataOnlyCapabilities, { backend: "workflow-extension-ipc" });

  assert.deepEqual(capabilities.families.canonicalDocument.write, {
    available: false,
    backend: "workflow-extension-ipc",
    guarantee: "none",
    unavailableReason: "canonical timeline writes are unavailable",
  });
  assert.deepEqual(capabilities.families.native.projectCreation, {
    available: false,
    backend: "workflow-extension-ipc",
    guarantee: "none",
    unavailableReason: "native project creation is unavailable",
  });
  assert.deepEqual(capabilities.families.native.clipInsertion, {
    available: false,
    backend: "workflow-extension-ipc",
    guarantee: "none",
    unavailableReason: "native clip insertion is unavailable",
  });
  assert.deepEqual(capabilities.families.native.clipMovement, {
    available: false,
    backend: "workflow-extension-ipc",
    guarantee: "none",
    unavailableReason: "native clip movement is unavailable",
  });
});
