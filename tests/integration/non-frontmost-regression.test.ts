import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  FinalCutCanonicalNativeProvider,
  FinalCutConnectionManager,
  FcpxmlDocumentAdapter,
  FinalCutNativeAutomationAdapter,
  FinalCutSessionAdapter,
} from "@framekit/final-cut";
import type {
  ContextRevision,
  EditorIdentity,
  EditorLiveState,
  ProjectCatalog,
  RuntimeCapabilities,
} from "@framekit/runtime";
import { AgentVideoRuntime } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import {
  evidenceFromPreflight,
  NON_FRONTMOST_EVIDENCE_TIERS,
} from "../../scripts/non-frontmost-evidence.mjs";
import { createMcpServer, type McpServerOptions } from "../../apps/mcp-server/src/server.js";

const FCPXML = `<?xml version="1.0"?>
<fcpxml version="1.11">
  <resources />
  <library><event><project uid="non-frontmost-project" name="Background Regression">
    <sequence uid="non-frontmost-sequence" duration="1s"><spine>
      <asset-clip id="non-frontmost-clip" name="Original" offset="0s" duration="1s" />
    </spine></sequence>
  </project></event></library>
</fcpxml>`;

const metadataCapabilities: RuntimeCapabilities = {
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

const liveIdentity: EditorIdentity = {
  name: "Final Cut Pro",
  version: "10.7.1",
  backend: "workflow-extension-ipc",
};

const liveState: EditorLiveState = {
  project: { id: "non-frontmost-project", name: "Background Regression" },
  sequence: {
    id: "non-frontmost-sequence",
    name: "Main",
    startTime: { value: "0", timescale: "24" },
    duration: { value: "24", timescale: "24" },
    frameDuration: { value: "1", timescale: "24" },
  },
  revision: { id: "live-1", sequence: 1, timestamp: new Date(1).toISOString() },
};

function makeLive(capabilities: RuntimeCapabilities = metadataCapabilities) {
  return {
    getIdentity: async () => liveIdentity,
    getCapabilities: async () => capabilities,
    readLiveState: async () => liveState,
    liveChangesSince: async (_revision: ContextRevision) => [],
  };
}

test("non-frontmost evidence maps every supported preflight tier", () => {
  assert.deepEqual(NON_FRONTMOST_EVIDENCE_TIERS, [
    "deterministic",
    "artifact",
    "metadata-only",
    "canonical-live",
    "headed-native",
  ]);

  assert.deepEqual(evidenceFromPreflight({
    mode: "fixture",
    documentMode: "fixture",
    processMode: "headless",
    backend: "fixture",
  }), {
    evidenceTier: "deterministic",
    provider: "fixture",
    documentMode: "fixture",
    processMode: "headless",
  });
});

test("background catalog routing does not request a canonical snapshot", async () => {
  let snapshotReads = 0;
  const catalog: ProjectCatalog = {
    projects: [{
      id: "non-frontmost-project",
      name: "Background Regression",
      sequences: [{ id: "non-frontmost-sequence", name: "Main" }],
    }],
    activeProjectId: "non-frontmost-project",
    activeSequenceId: "non-frontmost-sequence",
  };
  const live = makeLive();
  const provider = new FinalCutCanonicalNativeProvider({
    live: {
      ...live,
      listProjects: async () => catalog,
    },
    backgroundCatalog: {
      backend: "final-cut-background-library",
      listProjects: async () => catalog,
    },
    native: {
      renameSelectedClip: async () => {
        throw new Error("native UI must not run");
      },
      undo: async () => ({ undone: true, verification: { verified: true } }),
    },
    readSnapshot: async () => {
      snapshotReads += 1;
      throw new Error("canonical snapshot must not run");
    },
    resolveTarget: async () => {},
  });

  const result = await withMcp(new AgentVideoRuntime(provider), {}, (client) => client.callTool({
    name: "project.list",
    arguments: {},
  }));
  const listed = JSON.parse(textFrom(result)) as ProjectCatalog;

  assert.equal(result.isError, undefined);
  assert.equal(listed.provenance?.catalog.source, "background-library");
  assert.equal(listed.provenance?.catalog.backend, "final-cut-background-library");
  assert.equal(listed.provenance?.live?.source, "live-socket");
  assert.equal(listed.provenance?.selection.available, false);
  assert.equal(snapshotReads, 0);
});

test("artifact workflow stays reversible without Final Cut UI access", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-non-frontmost-artifact-"));
  const artifactPath = join(directory, "project.fcpxml");
  await writeFile(artifactPath, FCPXML);

  try {
    const runtime = new AgentVideoRuntime(new FcpxmlDocumentAdapter(artifactPath));
    const result = await withMcp(runtime, {
      connectionStatus: () => ({ state: "unavailable", lastError: { code: "FINAL_CUT_ABSENT", message: "Final Cut is absent" } }),
    }, async (client) => {
      const inspected = JSON.parse(textFrom(await client.callTool({ name: "editor.inspect", arguments: {} })));
      const before = JSON.parse(textFrom(await client.callTool({ name: "project.inspect", arguments: {} })));
      const preview = JSON.parse(textFrom(await client.callTool({
        name: "artifact.edit.preview",
        arguments: {
          artifactPath,
          baseRevision: before.revision,
          operations: [{
            type: "rename-clip",
            clipId: "non-frontmost-clip",
            name: "Background rename",
          }],
        },
      })));
      const executed = JSON.parse(textFrom(await client.callTool({
        name: "artifact.edit.execute",
        arguments: { previewToken: preview.previewToken },
      })));
      const diff = JSON.parse(textFrom(await client.callTool({
        name: "artifact.edit.diff",
        arguments: { artifactPath, transactionId: executed.id },
      })));
      const verification = JSON.parse(textFrom(await client.callTool({
        name: "artifact.edit.verify",
        arguments: { artifactPath, transactionId: executed.id },
      })));
      const undone = JSON.parse(textFrom(await client.callTool({
        name: "artifact.edit.undo",
        arguments: { artifactPath, transactionId: executed.id },
      })));
      return { inspected, preview, executed, diff, verification, undone };
    });

    assert.deepEqual(evidenceFromPreflight(result.inspected.preflight), {
      evidenceTier: "artifact",
      provider: "fcpxml-document",
      documentMode: "fcpxml-artifact",
      processMode: "headless",
    });
    assert.equal(result.inspected.workflows.artifact.requiresFinalCutFrontmost, false);
    assert.equal(result.inspected.workflows.artifact.changesOpenTimeline, false);
    assert.equal(result.preview.artifact.mutatesOpenTimeline, false);
    assert.equal(result.executed.status, "VERIFIED");
    assert.equal(result.diff.provenance.surface, "artifact");
    assert.equal(result.verification.provenance.revisionScope, "artifact");
    assert.equal(result.undone.provenance.mutatesOpenTimeline, false);
    assert.match(await readFile(artifactPath, "utf8"), /name="Original"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("editor inspection keeps evidence tiers and providers distinct", async () => {
  const fixture = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "fixture-project",
    projectName: "Fixture",
    timelineId: "fixture-sequence",
    timelineName: "Main",
    clips: [],
  }));
  const artifact = new AgentVideoRuntime(new FcpxmlDocumentAdapter("/tmp/non-frontmost.fcpxml"));
  const metadata = new AgentVideoRuntime(new FinalCutSessionAdapter({
    live: {
      ...makeLive(),
      listProjects: async () => ({ projects: [], activeProjectId: undefined, activeSequenceId: undefined }),
    },
  }));
  const canonical = new AgentVideoRuntime(new FinalCutSessionAdapter({
    live: {
      ...makeLive({
        ...metadataCapabilities,
        editor: { ...metadataCapabilities.editor, timelineSnapshotRead: true },
      }),
      getCapabilities: async () => ({
        ...metadataCapabilities,
        editor: { ...metadataCapabilities.editor, timelineSnapshotRead: true },
      }),
      readProject: async () => { throw new Error("snapshot not needed for inspect"); },
    },
  }));
  const headed = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "headed-project",
    projectName: "Headed fixture",
    timelineId: "headed-sequence",
    timelineName: "Main",
    clips: [],
  }));

  const inspected = await Promise.all([
    inspectEditor(fixture),
    inspectEditor(artifact),
    inspectEditor(metadata, { processMode: "headless" }),
    inspectEditor(canonical, { processMode: "headless" }),
    inspectEditor(headed, {
      processMode: "headed",
      nativeEditor: new FinalCutNativeAutomationAdapter({ enabled: true }),
    }),
  ]);

  assert.deepEqual(inspected.map((value) => evidenceFromPreflight(value.preflight)), [
    { evidenceTier: "deterministic", provider: "fixture", documentMode: "fixture", processMode: "headless" },
    { evidenceTier: "artifact", provider: "fcpxml-document", documentMode: "fcpxml-artifact", processMode: "headless" },
    { evidenceTier: "metadata-only", provider: "workflow-extension-ipc", documentMode: "metadata-only", processMode: "headless" },
    { evidenceTier: "canonical-live", provider: "workflow-extension-ipc", documentMode: "canonical-live", processMode: "headless" },
    { evidenceTier: "headed-native", provider: "fixture", documentMode: "fixture", processMode: "headed" },
  ]);
});

test("absent Final Cut returns bounded structured native blockers", async () => {
  const events: string[] = [];
  const manager = new FinalCutConnectionManager({
    headless: true,
    detectFinalCut: async () => { events.push("detect"); return false; },
    launchFinalCut: async () => { events.push("launch"); },
    probe: async () => { throw new Error("socket missing"); },
  });
  const startedAt = Date.now();
  const status = await manager.ensureConnected();

  assert.ok(Date.now() - startedAt < 500);
  assert.equal(status.state, "unavailable");
  assert.equal(status.lastError?.code, "FINAL_CUT_HEADLESS_SOCKET_UNAVAILABLE");
  assert.deepEqual(events, []);

  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "native-blocker-project",
    projectName: "Native blocker",
    timelineId: "native-blocker-sequence",
    timelineName: "Main",
    clips: [],
  }));
  const result = await withMcp(runtime, {
    processMode: "headed",
    nativeEditor: new FinalCutNativeAutomationAdapter({ enabled: false }),
  }, (client) => client.callTool({ name: "editor.native.inspect", arguments: {} }));
  const payload = JSON.parse(textFrom(result));

  assert.equal(payload.available, false);
  assert.equal(payload.error.code, "CAPABILITY_UNAVAILABLE");
  assert.ok(Date.now() - startedAt < 500);
});

async function inspectEditor(runtime: AgentVideoRuntime, options: McpServerOptions = {}) {
  return withMcp(runtime, options, async (client) => JSON.parse(textFrom(await client.callTool({
    name: "editor.inspect",
    arguments: {},
  }))));
}

async function withMcp<T>(
  runtime: AgentVideoRuntime,
  options: McpServerOptions,
  action: (client: Client) => Promise<T>,
): Promise<T> {
  const server = createMcpServer(runtime, options);
  const client = new Client({ name: "non-frontmost-regression-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return await action(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { text?: unknown } | undefined;
  assert.equal(typeof first?.text, "string");
  return first?.text as string;
}
