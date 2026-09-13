import assert from "node:assert/strict";
import test from "node:test";
import {
  FinalCutCanonicalNativeProvider,
  type FinalCutBackgroundCatalogProvider,
} from "@framekit/final-cut";
import type {
  ContextRevision,
  EditorChange,
  EditorIdentity,
  EditorLiveState,
  ProjectCatalog,
  ProjectSnapshot,
  RuntimeCapabilities,
} from "@framekit/runtime";

const identity: EditorIdentity = {
  name: "Final Cut Pro",
  version: "10.7.1",
  backend: "workflow-extension-ipc",
};

const capabilities: RuntimeCapabilities = {
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
    projectSelection: false,
  },
  analyzers: {
    speechTranscribe: false,
    speechVad: false,
    audioLoudness: false,
    visualTrack: false,
  },
};

const live: {
  getIdentity(): Promise<EditorIdentity>;
  getCapabilities(): Promise<RuntimeCapabilities>;
  readLiveState(): Promise<EditorLiveState>;
  liveChangesSince(revision: ContextRevision, waitMs?: number): Promise<EditorChange[]>;
} = {
  getIdentity: async () => identity,
  getCapabilities: async () => capabilities,
  readLiveState: async () => ({
    project: { id: "background-project", name: "Background Project" },
    sequence: {
      id: "background-sequence",
      name: "Main",
      startTime: { value: "0", timescale: "24" },
      duration: { value: "96", timescale: "24" },
      frameDuration: { value: "1", timescale: "24" },
    },
    revision: { id: "live-1", sequence: 1, timestamp: new Date(1).toISOString() },
  }),
  liveChangesSince: async () => [],
};

function catalog(): ProjectCatalog {
  return {
    projects: [
      {
        id: "background-project",
        name: "Background Project",
        sequences: [{ id: "background-sequence", name: "Main" }],
      },
      {
        id: "other-project",
        name: "Other Project",
        sequences: [{ id: "other-sequence", name: "Social" }],
      },
    ],
    activeProjectId: "background-project",
    activeSequenceId: "background-sequence",
  };
}

function providerFor(
  backgroundCatalog: FinalCutBackgroundCatalogProvider,
  readSnapshot: () => Promise<ProjectSnapshot>,
) {
  return new FinalCutCanonicalNativeProvider({
    live,
    backgroundCatalog,
    native: {
      renameSelectedClip: async () => ({ operationId: "native-operation", undoAvailable: true }),
      undo: async () => ({ undone: true, verification: { verified: true } }),
    },
    readSnapshot,
    resolveTarget: async () => undefined,
  });
}

test("canonical catalog routing uses background data without canonical snapshot export", async () => {
  let snapshotReads = 0;
  const provider = providerFor({
    backend: "final-cut-background-library",
    listProjects: async () => catalog(),
  }, async () => {
    snapshotReads += 1;
    throw new Error("canonical Export XML must not run for project.list");
  });

  const listed = await provider.listProjects();

  assert.deepEqual(listed.projects, catalog().projects);
  assert.equal(listed.activeProjectId, "background-project");
  assert.equal(listed.activeSequenceId, "background-sequence");
  assert.equal(snapshotReads, 0);
});

test("background catalogs reject duplicate and inconsistent identities", async () => {
  const duplicate = catalog();
  duplicate.projects.push({
    id: "background-project",
    name: "Duplicate",
    sequences: [{ id: "duplicate-sequence", name: "Duplicate" }],
  });
  const provider = providerFor({
    backend: "final-cut-background-library",
    listProjects: async () => duplicate,
  }, async () => {
    throw new Error("canonical snapshot must not run");
  });

  await assert.rejects(provider.listProjects(), /PROJECT_CATALOG_INVALID: duplicate project id background-project/);
});
