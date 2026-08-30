import assert from "node:assert/strict";
import test from "node:test";
import { FcpxmlDocumentAdapter, FinalCutLiveAdapter, FinalCutSessionAdapter } from "@framekit/final-cut";
import { withCapabilityFamilies } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";

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

test("deterministic fixture capabilities identify their backend and operation support", async () => {
  const capabilities = await new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Fixture",
    timelineId: "timeline-1",
    timelineName: "Main",
    clips: [],
  }).getCapabilities();

  assert.equal(capabilities.schemaVersion, 1);
  assert.equal(capabilities.families?.connection.status.backend, "fixture");
  assert.equal(capabilities.families?.canonicalDocument.write.available, true);
  assert.equal(capabilities.families?.native.titlePlacement.available, false);
});

test("FCPXML capabilities keep artifact editing separate from live editing", async () => {
  const capabilities = await new FcpxmlDocumentAdapter("/tmp/project.fcpxml").getCapabilities();

  assert.equal(capabilities.schemaVersion, 1);
  assert.equal(capabilities.families?.canonicalDocument.artifactWrite.available, true);
  assert.equal(capabilities.families?.canonicalDocument.artifactWrite.backend, "fcpxml-document");
  assert.equal(capabilities.families?.canonicalDocument.write.available, false);
  assert.equal(capabilities.families?.observation.timeline.available, true);
});

test("live capability responses retain metadata-only provenance", async () => {
  const adapter = new FinalCutLiveAdapter({
    request: async (request) => ({
      version: 1,
      id: request.id,
      ok: true,
      result: {
        identity: { name: "Final Cut Pro", version: "test", backend: "workflow-extension-ipc" },
        capabilities: metadataOnlyCapabilities,
      },
    }),
  });
  const capabilities = await adapter.getCapabilities();

  assert.equal(capabilities.schemaVersion, 1);
  assert.equal(capabilities.families?.connection.status.backend, "workflow-extension-ipc");
  assert.equal(capabilities.families?.observation.timeline.guarantee, "observed");
  assert.equal(capabilities.families?.canonicalDocument.read.available, false);
  assert.equal(capabilities.families?.native.clipMovement.available, false);
});

test("session capabilities identify the composed backend without inheriting native writes", async () => {
  const session = new FinalCutSessionAdapter({
    snapshot: new FcpxmlDocumentAdapter("/tmp/project.fcpxml"),
  });
  const capabilities = await session.getCapabilities();

  assert.equal(capabilities.schemaVersion, 1);
  assert.equal(capabilities.families?.connection.status.backend, "final-cut-session");
  assert.equal(capabilities.families?.canonicalDocument.read.available, true);
  assert.equal(capabilities.families?.canonicalDocument.artifactWrite.available, false);
  assert.equal(capabilities.families?.native.selectionWrite.available, false);
});
