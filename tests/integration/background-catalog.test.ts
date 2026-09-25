import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  FinalCutCanonicalNativeProvider,
  FinalCutSessionAdapter,
  type FinalCutBackgroundCatalogProvider,
} from "@framekit/final-cut";
import type {
  AgentVideoRuntime,
  ContextRevision,
  EditorChange,
  EditorIdentity,
  EditorLiveState,
  ProjectCatalog,
  ProjectSnapshot,
  RuntimeCapabilities,
} from "@framekit/runtime";
import { AgentVideoRuntime as Runtime } from "@framekit/runtime";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

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

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { text?: unknown } | undefined;
  assert.ok(first);
  assert.equal(typeof first?.text, "string");
  return first.text as string;
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
  assert.equal(listed.provenance?.catalog.source, "background-library");
  assert.equal(listed.provenance?.live?.source, "live-socket");
  assert.equal(listed.provenance?.reconciliation.status, "matched");
  assert.equal(listed.provenance?.selection.available, false);
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

test("canonical provider fails closed when background project selection is unavailable", async () => {
  const provider = providerFor({
    backend: "final-cut-background-library",
    listProjects: async () => catalog(),
  }, async () => {
    throw new Error("canonical snapshot must not run");
  });

  await assert.rejects(
    provider.selectProject({ projectId: "background-project", sequenceId: "background-sequence" }),
    /CAPABILITY_UNAVAILABLE: Final Cut project selection is not exposed by the background provider/,
  );
});

test("MCP project.list preserves background reconciliation provenance", async () => {
  const provider = providerFor({
    backend: "final-cut-background-library",
    listProjects: async () => catalog(),
  }, async () => {
    throw new Error("canonical snapshot must not run");
  });
  const runtime: AgentVideoRuntime = new Runtime(new FinalCutSessionAdapter({ live: provider }));
  const server = createMcpServer(runtime);
  const client = new Client({ name: "background-catalog-mcp-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = JSON.parse(textFrom(await client.callTool({ name: "project.list", arguments: {} }))) as ProjectCatalog;
    assert.equal(result.provenance?.catalog.backend, "final-cut-background-library");
    assert.equal(result.provenance?.live?.state.revision.id, "live-1");
    assert.equal(result.provenance?.reconciliation.status, "matched");
    assert.equal(result.provenance?.selection.unavailableReason, "project selection is not exposed by the background provider");

    const route = JSON.parse(textFrom(await client.callTool({
      name: "editing.route",
      arguments: { operation: "project.list" },
    }))) as {
      selectedPath?: string;
      provider?: { backend?: string; guarantee?: string };
    };
    assert.equal(route.selectedPath, "background");
    assert.deepEqual(route.provider, {
      backend: "final-cut-background-library",
      guarantee: "observed",
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("normal live sessions reconcile project catalogs before returning them", async () => {
  const session = new FinalCutSessionAdapter({
    live: {
      ...live,
      getCapabilities: async () => ({
        ...capabilities,
        editor: {
          ...capabilities.editor,
          timelineSnapshotRead: false,
          timelineWrite: false,
          readAfterWrite: false,
          rollback: false,
        },
      }),
      listProjects: async () => catalog(),
    },
  });

  const listed = await session.listProjects();
  const sessionCapabilities = await session.getCapabilities();

  assert.equal(listed.activeProjectId, "background-project");
  assert.equal(listed.activeSequenceId, "background-sequence");
  assert.equal(listed.provenance?.reconciliation.status, "matched");
  assert.equal(listed.provenance?.live?.state.revision.id, "live-1");
  assert.equal(sessionCapabilities.editor.backgroundLibraryInspection, true);
  assert.deepEqual(sessionCapabilities.families?.observation.library, {
    available: true,
    backend: "final-cut-background-library",
    guarantee: "observed",
  });
});

test("unresolved catalog reconciliation keeps canonical capabilities unavailable", async () => {
  const session = new FinalCutSessionAdapter({
    live: {
      ...live,
      getCapabilities: async () => ({
        ...capabilities,
        editor: {
          ...capabilities.editor,
          projectRead: false,
          timelineSnapshotRead: false,
          timelineWrite: false,
          readAfterWrite: false,
          rollback: false,
          projectCatalogRead: true,
          projectSelection: false,
        },
      }),
      listProjects: async () => ({
        projects: [{
          id: "catalog-project",
          name: "Background Project",
          sequences: [{ id: "catalog-sequence", name: "Main" }],
        }],
      }),
    },
  });

  const listed = await session.listProjects();
  const sessionCapabilities = await session.getCapabilities();
  const reconciliation = listed.provenance?.reconciliation;
  assert.ok(reconciliation);

  assert.equal(listed.activeProjectId, undefined);
  assert.equal(listed.activeSequenceId, undefined);
  assert.equal(reconciliation.status, "unresolved");
  assert.equal(reconciliation.diagnostics?.[0]?.code, "stable-id-mismatch");
  assert.deepEqual(reconciliation.blocker, {
    code: "target-selection-required",
    message: "target selection is required before canonical operations",
  });
  assert.match(
    listed.provenance?.selection.unavailableReason ?? "",
    /^target selection is required before canonical operations:/,
  );
  assert.equal(sessionCapabilities.editor.canonicalTimelineMode, "metadata-only");
  assert.equal(sessionCapabilities.families?.canonicalDocument.read.available, false);
  assert.equal(sessionCapabilities.families?.canonicalDocument.write.available, false);
});

test("sessions expose an explicitly injected background catalog beside metadata-only live state", async () => {
  const session = new FinalCutSessionAdapter({
    live: {
      ...live,
      getCapabilities: async () => ({
        ...capabilities,
        editor: {
          ...capabilities.editor,
          projectRead: false,
          timelineSnapshotRead: false,
          timelineWrite: false,
          timelineArtifactWrite: false,
          readAfterWrite: false,
          rollback: false,
          projectCatalogRead: false,
          projectSelection: false,
        },
      }),
    },
    backgroundCatalog: {
      backend: "final-cut-background-library",
      listProjects: async () => catalog(),
    },
  });

  const listed = await session.listProjects();
  const sessionCapabilities = await session.getCapabilities();

  assert.equal(sessionCapabilities.editor.backgroundLibraryInspection, true);
  assert.equal(sessionCapabilities.editor.projectCatalogRead, true);
  assert.deepEqual(sessionCapabilities.families?.observation.library, {
    available: true,
    backend: "final-cut-background-library",
    guarantee: "observed",
  });
  assert.equal(listed.provenance?.catalog.source, "background-library");
});
