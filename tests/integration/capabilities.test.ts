import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CommandVisualAnalyzer,
  FcpxmlDocumentAdapter,
  FinalCutConnectionManager,
  FinalCutLiveAdapter,
  FinalCutSessionAdapter,
} from "@framekit/final-cut";
import type { NativeFinalCutEditor } from "@framekit/final-cut";
import { AgentVideoRuntime, withCanonicalTimelineMode, withCapabilityFamilies } from "@framekit/runtime";
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

test("project selection capabilities expose their execution mode", () => {
  const background = withCapabilityFamilies({
    ...artifactCapabilities,
    editor: { ...artifactCapabilities.editor, projectSelectionMode: "background-capable" },
  }, { backend: "fcpxml-document" });
  const headed = withCapabilityFamilies({
    ...artifactCapabilities,
    editor: { ...artifactCapabilities.editor, projectSelectionMode: "headed-only" },
  }, { backend: "final-cut-accessibility" });
  const unavailable = withCapabilityFamilies({
    ...metadataOnlyCapabilities,
    editor: { ...metadataOnlyCapabilities.editor, projectSelectionMode: "unavailable" },
  }, { backend: "workflow-extension-ipc" });
  const legacyBackground = withCapabilityFamilies(artifactCapabilities, { backend: "fcpxml-document" });
  const legacyUnavailable = withCapabilityFamilies(metadataOnlyCapabilities, { backend: "workflow-extension-ipc" });

  assert.equal(background.editor.projectSelectionMode, "background-capable");
  assert.equal(background.editor.timelineWrite, false);
  assert.notEqual(background.editor.canonicalTimelineMode, "canonical-write");
  assert.equal(headed.editor.projectSelectionMode, "headed-only");
  assert.equal(unavailable.editor.projectSelectionMode, "unavailable");
  assert.equal(legacyBackground.editor.projectSelectionMode, "background-capable");
  assert.equal(legacyUnavailable.editor.projectSelectionMode, "unavailable");
});

test("background family does not infer native evidence from editor flags", () => {
  const capabilities = withCapabilityFamilies({
    ...artifactCapabilities,
    editor: { ...artifactCapabilities.editor, backgroundRender: true },
  }, { backend: "external-renderer" });

  assert.equal(capabilities.editor.backgroundRender, true);
  assert.equal(capabilities.families.export.background.available, false);
  assert.equal(capabilities.families.export.background.evidenceTier, undefined);
});

test("background library capability reports observed provider provenance", () => {
  const capabilities = withCapabilityFamilies({
    editor: {
      ...metadataOnlyCapabilities.editor,
      projectCatalogRead: true,
      backgroundLibraryInspection: true,
    },
    analyzers: metadataOnlyCapabilities.analyzers,
  }, {
    backend: "final-cut-session",
    observation: {
      library: {
        available: true,
        backend: "final-cut-background-library",
        guarantee: "observed",
      },
    },
  });

  assert.deepEqual(capabilities.families.observation.library, {
    available: true,
    backend: "final-cut-background-library",
    guarantee: "observed",
  });
  assert.equal(capabilities.editor.canonicalTimelineMode, "metadata-only");
  assert.equal(capabilities.families.canonicalDocument.read.available, false);
});

test("background library capability is unavailable without explicit provider support", () => {
  const capabilities = withCapabilityFamilies(metadataOnlyCapabilities, {
    backend: "workflow-extension-ipc",
  });

  assert.deepEqual(capabilities.families.observation.library, {
    available: false,
    backend: "workflow-extension-ipc",
    guarantee: "none",
    unavailableReason: "background library inspection is unavailable",
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

test("capability normalization invalidates stale descriptors after a downgrade", () => {
  const canonicalWrite = withCapabilityFamilies({
    editor: {
      ...artifactCapabilities.editor,
      timelineWrite: true,
      timelineArtifactWrite: false,
      readAfterWrite: true,
      rollback: true,
      projectRead: true,
      projectCatalogRead: true,
      projectSelection: true,
      compositeTransactions: true,
    },
    analyzers: artifactCapabilities.analyzers,
  }, { backend: "canonical-live-ipc" });

  const downgraded = withCanonicalTimelineMode({
    ...canonicalWrite,
    editor: {
      ...canonicalWrite.editor,
      timelineWrite: false,
      projectCatalogRead: false,
      projectSelection: false,
    },
  });

  assert.equal(downgraded.editor.canonicalTimelineMode, "metadata-only");
  assert.equal(downgraded.families?.canonicalDocument.write.available, false);
  assert.equal(downgraded.families?.canonicalDocument.write.backend, "canonical-live-ipc");
  assert.equal(downgraded.families?.editing.compositeTransactions.available, false);
  assert.equal(downgraded.families?.editing.compositeTransactions.backend, "canonical-live-ipc");
});

test("capability normalization invalidates stale background media descriptors", () => {
  const background = withCapabilityFamilies({
    editor: {
      ...metadataOnlyCapabilities.editor,
      backgroundMediaDiscovery: true,
    },
    analyzers: metadataOnlyCapabilities.analyzers,
  }, {
    backend: "filesystem-media",
    observation: {
      media: { available: true, backend: "filesystem-media", guarantee: "observed" },
    },
  });

  const downgraded = withCanonicalTimelineMode({
    ...background,
    editor: {
      ...background.editor,
      backgroundMediaDiscovery: false,
    },
  });

  assert.deepEqual(downgraded.families?.observation.media, {
    available: false,
    backend: "filesystem-media",
    guarantee: "none",
    unavailableReason: "media observation is unavailable",
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
      titleDiscovery: true,
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
    assert.equal(payload.capabilities.families.native.titleDiscovery.available, true);
    assert.equal(payload.capabilities.families.native.selectionWrite.backend, "final-cut-accessibility");
    assert.equal(payload.capabilities.families.native.clipInsertion.available, false);
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

test("MCP editor inspection preserves configured analyzer provider provenance", async () => {
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Analyzer Provenance Fixture",
    timelineId: "timeline-1",
    timelineName: "Main",
    clips: [],
  }), {
    visualAnalyzer: new CommandVisualAnalyzer({ command: "/usr/bin/true" }),
  });
  const server = createMcpServer(runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "analyzer-provenance-test", version: "0.1.0" });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "editor.inspect", arguments: {} });
    const payload = JSON.parse(textFrom(result));

    assert.equal(payload.identity.backend, "fixture");
    assert.equal(payload.capabilities.families.analyzers.visualTrack.available, true);
    assert.equal(payload.capabilities.families.analyzers.visualTrack.backend, "command");
  } finally {
    await client.close();
    await server.close();
  }
});

test("editor inspection preserves each configured analyzer provider backend", async () => {
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Analyzer Provider Fixture",
    timelineId: "timeline-1",
    timelineName: "Main",
    clips: [],
  }), {
    speechAnalyzer: {
      descriptor: { id: "speech.test", provider: "speech-provider" },
      capabilities: { transcription: true, vad: true },
      analyze: async () => ({ words: [] }),
    },
    audioAnalyzer: {
      descriptor: { id: "audio.test", provider: "audio-provider" },
      analyze: async () => ({ integratedLufs: -18, truePeakDb: -3, silenceMs: 0 }),
    },
    noiseAnalyzer: {
      descriptor: { id: "noise.test", provider: "noise-provider" },
      analyze: async () => ({
        noiseFloorDb: -60,
        affectedRanges: [],
        recommendedReductionDb: 0,
        confidence: 1,
      }),
    },
    visualAnalyzer: {
      descriptor: { id: "visual.test", provider: "visual-provider" },
      analyze: async () => ({ scenes: [], subjects: [], keyframes: [] }),
    },
  });
  const inspected = await runtime.inspectEditor();
  const analyzers = inspected.capabilities.families.analyzers;

  assert.deepEqual({
    speechTranscribe: analyzers.speechTranscribe.backend,
    speechVad: analyzers.speechVad.backend,
    audioLoudness: analyzers.audioLoudness.backend,
    audioNoise: analyzers.audioNoise?.backend,
    visualTrack: analyzers.visualTrack.backend,
  }, {
    speechTranscribe: "speech-provider",
    speechVad: "speech-provider",
    audioLoudness: "audio-provider",
    audioNoise: "noise-provider",
    visualTrack: "visual-provider",
  });
});

test("capability documentation describes the versioned operation contract", async () => {
  const architecture = await readFile(join(process.cwd(), "docs/architecture/capability-model.md"), "utf8");
  const mcp = await readFile(join(process.cwd(), "docs/mcp/capabilities-and-errors.md"), "utf8");
  const documentation = `${architecture}\n${mcp}`;

  assert.match(documentation, /schemaVersion/);
  assert.match(documentation, /families/);
  assert.match(documentation, /unavailableReason/);
  assert.match(documentation, /canonicalDocument/);
  assert.match(documentation, /editing/);
  assert.match(documentation, /pictureInPicture/);
  assert.match(documentation, /masking/);
  assert.match(documentation, /preflight/);
  assert.match(documentation, /documentMode/);
  assert.match(documentation, /processMode/);
  assert.match(documentation, /native-write/);
  assert.match(documentation, /projectCreation/);
  assert.match(documentation, /clipInsertion/);
  assert.match(documentation, /clipMovement/);
  assert.match(documentation, /backgroundMediaDiscovery/);
  assert.match(documentation, /backgroundTemplateDiscovery/);
  assert.match(documentation, /backgroundLibraryInspection/);
  assert.match(documentation, /observation\.library/);
  assert.match(documentation, /final-cut-background-library/);
  assert.match(documentation, /metadata-only/);
  assert.match(documentation, /canonical timeline evidence/);
  assert.match(mcp, /FRAMEKIT_FINAL_CUT_MEDIA_ROOTS/);
  assert.match(mcp, /discovery: \"native\"/);
  assert.match(architecture, /`editor\.projectRead` is disabled/);
  assert.match(mcp, /"projectRead": false/);
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
    assert.equal(payload.capabilities.families.canonicalDocument.write.available, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP connection status preserves malformed capabilities without throwing", async () => {
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Malformed Connection Fixture",
    timelineId: "timeline-1",
    timelineName: "Main",
    clips: [],
  }));
  const server = createMcpServer(runtime, {
    connectionStatus: () => ({ state: "ready", capabilities: {} }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "malformed-connection-capabilities-test", version: "0.1.0" });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "connection.status", arguments: {} });
    const payload = JSON.parse(textFrom(result));

    assert.deepEqual(payload, { state: "ready", capabilities: {} });
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
  assert.match(swift, /titleDiscovery: CapabilityDescriptor/);
  assert.match(swift, /pictureInPicture: CapabilityDescriptor/);
  assert.match(swift, /projectCatalogRead: Bool/);
  assert.match(swift, /projectSelection: Bool/);
  assert.match(swift, /projectSelectionMode: String/);
  assert.match(swift, /transitionDiscovery: CapabilityDescriptor/);
  assert.match(swift, /transitionPlacement: CapabilityDescriptor/);
});

test("Workflow Extension does not advertise unsupported project catalog operations", async () => {
  const swift = await readFile(join(
    process.cwd(),
    "adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/FinalCutLiveWorkflowExtension.swift",
  ), "utf8");

  assert.match(swift, /projectCatalogRead: false, projectSelection: false, projectSelectionMode: "unavailable"/);
});

test("canonical native provider declares unavailable project selection mode", async () => {
  const canonical = await readFile(join(
    process.cwd(),
    "adapters/final-cut/typescript/src/canonical.ts",
  ), "utf8");

  assert.match(canonical, /projectCatalogRead: true,\s*projectSelection: false,\s*projectSelectionMode: "unavailable"/);
});

test("Workflow Extension avoids unsupported project catalog proxy properties", async () => {
  const swift = await readFile(join(
    process.cwd(),
    "adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/FinalCutLiveWorkflowExtension.swift",
  ), "utf8");

  assert.doesNotMatch(swift, /library\.events.*flatMap/);
  assert.doesNotMatch(swift, /stableSequenceID\(.*\.uid\)/);
});

test("CodeQL shim exposes only documented project proxy properties", async () => {
  const shim = await readFile(join(
    process.cwd(),
    ".github/codeql/FinalCutWorkflowExtensionShim.swift",
  ), "utf8");

  assert.doesNotMatch(shim, /class FCPXObject[^{]*\{[^}]*var uid:/);
  assert.doesNotMatch(shim, /class FCPXEvent/);
  assert.doesNotMatch(shim, /class FCPXLibrary/);
  assert.match(shim, /class FCPXProject[^{]*\{[^}]*var uid: String!/);
});

test("Workflow Extension rejects unsupported project catalog methods", async () => {
  const swift = await readFile(join(
    process.cwd(),
    "adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/FinalCutLiveWorkflowExtension.swift",
  ), "utf8");

  assert.match(swift, /case "projects", "select-project":[\s\S]*CAPABILITY_UNAVAILABLE/);
  assert.doesNotMatch(swift, /private func selectProject\(/);
});

test("project selection decision records API and runtime evidence", async () => {
  const decision = await readFile(join(
    process.cwd(),
    "docs/adr/0009-non-ui-project-selection.md",
  ), "utf8");

  assert.match(decision, /FCPXHost/);
  assert.match(decision, /FCPXTimeline\.activeSequence/);
  assert.match(decision, /projectCatalogRead: false/);
  assert.match(decision, /projectSelection: false/);
  assert.match(decision, /select-project/);
  assert.match(decision, /CAPABILITY_UNAVAILABLE/);
  assert.match(decision, /projectSelectionMode/);
});

test("headed project selection gate verifies transition evidence", async () => {
  const runner = await readFile(join(
    process.cwd(),
    "scripts/final-cut-project-selection-headed-e2e.mjs",
  ), "utf8");

  assert.match(runner, /projectSelectionMode/);
  assert.match(runner, /requestedTarget/);
  assert.match(runner, /observedActiveTarget/);
  assert.match(runner, /observedRevision/);
});
