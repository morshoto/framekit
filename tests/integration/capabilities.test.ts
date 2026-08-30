import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  FcpxmlDocumentAdapter,
  FinalCutConnectionManager,
  FinalCutLiveAdapter,
  FinalCutSessionAdapter,
} from "@framekit/final-cut";
import type { NativeFinalCutEditor } from "@framekit/final-cut";
import { AgentVideoRuntime, withCapabilityFamilies } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";
import { join } from "node:path";

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { text?: unknown } | undefined;
  assert.ok(first);
  assert.equal(typeof first.text, "string");
  return first.text as string;
}

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

test("canonical writes retain canonical-read guarantees and asset discovery is not media observation", () => {
  const canonicalWrite = withCapabilityFamilies({
    editor: {
      ...artifactCapabilities.editor,
      timelineWrite: true,
    },
    analyzers: artifactCapabilities.analyzers,
  }, { backend: "canonical-live-ipc" });
  const assetOnly = withCapabilityFamilies({
    editor: {
      ...metadataOnlyCapabilities.editor,
      assetDiscovery: true,
    },
    analyzers: metadataOnlyCapabilities.analyzers,
  }, { backend: "motion-template-registry" });

  assert.equal(canonicalWrite.families.canonicalDocument.read.guarantee, "canonical-read");
  assert.equal(canonicalWrite.families.canonicalDocument.write.available, true);
  assert.equal(assetOnly.families.observation.media.available, false);
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

test("live capability normalization preserves native backend provenance", async () => {
  const adapter = new FinalCutLiveAdapter({
    request: async (request) => ({
      version: 1,
      id: request.id,
      ok: true,
      result: {
        identity: { name: "Final Cut Pro", version: "test", backend: "workflow-extension-ipc" },
        capabilities: withCapabilityFamilies(metadataOnlyCapabilities, {
          backend: "workflow-extension-ipc",
          nativeBackend: "final-cut-accessibility",
        }),
      },
    }),
  });

  const capabilities = await adapter.getCapabilities();

  assert.equal(capabilities.families?.native.selectionWrite.backend, "final-cut-accessibility");
});

test("session capabilities identify the composed backend without inheriting native writes", async () => {
  const session = new FinalCutSessionAdapter({
    snapshot: new FcpxmlDocumentAdapter("/tmp/project.fcpxml"),
  });
  const capabilities = await session.getCapabilities();

  assert.equal(capabilities.schemaVersion, 1);
  assert.equal(capabilities.families?.connection.status.backend, "final-cut-session");
  assert.equal(capabilities.families?.canonicalDocument.read.available, true);
  assert.equal(capabilities.families?.canonicalDocument.artifactWrite.available, true);
  assert.equal(capabilities.families?.native.selectionWrite.available, false);
});

test("ready connection status carries versioned capabilities without implying writes", async () => {
  const manager = new FinalCutConnectionManager({
    probe: async () => ({
      identity: { name: "Final Cut Pro", version: "test", backend: "workflow-extension-ipc" },
      capabilities: metadataOnlyCapabilities,
    }),
  });
  const status = await manager.ensureConnected();

  assert.equal(status.state, "ready");
  assert.equal(status.capabilities?.schemaVersion, 1);
  assert.equal(status.capabilities?.families?.connection.status.available, true);
  assert.equal(status.capabilities?.families?.canonicalDocument.write.available, false);
});

test("MCP editor inspection exposes native, publishing, export, and analyzer families", async () => {
  const nativeEditor = {
    capabilities: () => ({
      selectionEdit: true,
      undo: true,
      mediaLibrarySearch: true,
      mediaImport: true,
      mediaSelection: true,
      mediaAppendSelected: true,
      timelineOccurrenceLocate: true,
      bladeAtPlayhead: true,
      deleteRange: true,
      trimToDuration: true,
      mediaAppend: true,
      mediaInsert: true,
      titlePlacement: true,
      timelineFocus: true,
      requiresAccessibility: true,
      requiresFinalCutFrontmost: true,
    }),
  } as unknown as NativeFinalCutEditor;
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "MCP Capability Fixture",
    timelineId: "timeline-1",
    timelineName: "Main",
    clips: [],
  }));
  const server = createMcpServer(runtime, {
    nativeEditor,
    projectPublisher: {} as never,
    videoExporter: { isAvailable: () => true } as never,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "capabilities-test", version: "0.1.0" });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "editor.inspect", arguments: {} });
    const payload = JSON.parse(textFrom(result));

    assert.equal(payload.capabilities.schemaVersion, 1);
    assert.equal(payload.capabilities.families.native.selectionWrite.available, true);
    assert.equal(payload.capabilities.families.native.selectionWrite.backend, "final-cut-accessibility");
    assert.equal(payload.capabilities.families.native.clipInsertion.available, true);
    assert.equal(payload.capabilities.families.native.projectCreation.available, false);
    assert.equal(payload.capabilities.families.native.clipMovement.available, false);
    assert.equal(payload.capabilities.families.publishing.projectCreation.available, true);
    assert.equal(payload.capabilities.families.publishing.projectCreation.backend, "fcpxml-publisher");
    assert.equal(payload.capabilities.families.export.timeline.available, true);
    assert.equal(payload.capabilities.families.export.timeline.backend, "final-cut-native-export");
  } finally {
    await client.close();
    await server.close();
  }
});

test("capability documentation describes the versioned operation contract", async () => {
  const architecture = await readFile(join(process.cwd(), "docs/architecture/capability-model.md"), "utf8");
  const mcp = await readFile(join(process.cwd(), "docs/mcp/capabilities-and-errors.md"), "utf8");
  const documentation = `${architecture}\n${mcp}`;

  assert.match(documentation, /schemaVersion/);
  assert.match(documentation, /families/);
  assert.match(documentation, /unavailableReason/);
  assert.match(documentation, /canonicalDocument/);
  assert.match(documentation, /projectCreation/);
  assert.match(documentation, /clipInsertion/);
  assert.match(documentation, /clipMovement/);
});

test("MCP connection status normalizes injected capability payloads", async () => {
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Connection Capability Fixture",
    timelineId: "timeline-1",
    timelineName: "Main",
    clips: [],
  }));
  const server = createMcpServer(runtime, {
    connectionStatus: () => ({
      state: "ready",
      identity: { name: "Final Cut Pro", version: "test", backend: "workflow-extension-ipc" },
      capabilities: metadataOnlyCapabilities,
    }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "connection-capabilities-test", version: "0.1.0" });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "connection.status", arguments: {} });
    const payload = JSON.parse(textFrom(result));

    assert.equal(payload.capabilities.schemaVersion, 1);
    assert.equal(payload.capabilities.families.connection.status.available, true);
    assert.equal(payload.capabilities.families.canonicalDocument.write.available, false);
  } finally {
    await client.close();
    await server.close();
  }
});

test("Workflow Extension capability payload defines the versioned family contract", async () => {
  const swift = await readFile(join(
    process.cwd(),
    "adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/FinalCutLiveWorkflowExtension.swift",
  ), "utf8");

  assert.match(swift, /let schemaVersion: Int/);
  assert.match(swift, /let families: CapabilityFamilies/);
  assert.match(swift, /projectCreation: CapabilityDescriptor/);
  assert.match(swift, /clipInsertion: CapabilityDescriptor/);
  assert.match(swift, /clipMovement: CapabilityDescriptor/);
  assert.match(swift, /titlePlacement: CapabilityDescriptor/);
});
