import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  FcpxmlDocumentAdapter,
  FinalCutLiveAdapter,
  FinalCutSessionAdapter,
} from "@framekit/final-cut";
import type { ContextRevision, ProjectSnapshot, WorkflowOperation } from "@framekit/runtime";
import { AgentVideoRuntime } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

const FCPXML = `<?xml version="1.0"?>
<fcpxml version="1.11">
  <resources />
  <library><event name="Event"><project uid="project-routing" name="Routing Project">
    <sequence uid="sequence-routing" duration="1s"><spine>
      <asset-clip id="clip-routing" name="Original" offset="0s" duration="1s" />
    </spine></sequence>
  </project></event></library>
</fcpxml>`;

class TrackingFcpxmlAdapter extends FcpxmlDocumentAdapter {
  public previewCalls = 0;
  public applyCalls = 0;

  public override async previewTransaction(
    operations: WorkflowOperation[],
    expectedRevision: ContextRevision,
  ): Promise<ProjectSnapshot> {
    this.previewCalls += 1;
    return super.previewTransaction(operations, expectedRevision);
  }

  public override async applyTransaction(
    operations: WorkflowOperation[],
    expectedRevision: ContextRevision,
  ): Promise<void> {
    this.applyCalls += 1;
    return super.applyTransaction(operations, expectedRevision);
  }
}

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { text?: unknown } | undefined;
  assert.equal(typeof first?.text, "string");
  return first?.text as string;
}

async function inspectWithMcp(
  runtime: AgentVideoRuntime,
  options: Parameters<typeof createMcpServer>[1] = {},
): Promise<any> {
  const server = createMcpServer(runtime, options);
  const client = new Client({ name: "preflight-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return JSON.parse(textFrom(await client.callTool({ name: "editor.inspect", arguments: {} })));
  } finally {
    await client.close();
    await server.close();
  }
}

test("Final Cut sessions route artifact composite transactions to the mutation provider", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-finalcut-routing-"));
  const artifactPath = join(directory, "project.fcpxml");

  try {
    await writeFile(artifactPath, FCPXML);
    const mutation = new TrackingFcpxmlAdapter(artifactPath);
    const runtime = new AgentVideoRuntime(new FinalCutSessionAdapter({
      snapshot: new FcpxmlDocumentAdapter(artifactPath),
      mutation,
    }));
    const before = await runtime.inspectProject();
    const inspected = await runtime.inspectEditor();

    assert.equal(inspected.capabilities.editor.compositeTransactions, true);
    assert.equal(inspected.capabilities.families?.editing.compositeTransactions.available, true);
    assert.equal(inspected.capabilities.families?.editing.compositeTransactions.backend, "fcpxml-document");

    const preview = await runtime.previewArtifactEdit(artifactPath, {
      baseRevision: before.revision,
      operations: [{ type: "rename-clip", clipId: before.timeline.clips[0]!.id, name: "Renamed" }],
    });
    assert.equal(mutation.previewCalls, 1);
    assert.equal(preview.expectedDiff.modified[0]?.after?.name, "Renamed");

    const transaction = await runtime.executeEdit(preview.previewToken);
    assert.equal(mutation.applyCalls, 1);
    assert.equal(transaction.status, "VERIFIED");
    assert.equal(transaction.after.timeline.clips[0]?.name, "Renamed");
    assert.equal(transaction.verification?.passed, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("editor inspection exposes actionable artifact preflight provenance", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-finalcut-preflight-"));
  const artifactPath = join(directory, "project.fcpxml");

  try {
    await writeFile(artifactPath, FCPXML);
    const document = new FcpxmlDocumentAdapter(artifactPath);
    const payload = await inspectWithMcp(new AgentVideoRuntime(new FinalCutSessionAdapter({
      snapshot: document,
      mutation: document,
    })));

    assert.equal(payload.preflight.mode, "fcpxml-artifact");
    assert.equal(payload.preflight.documentMode, "fcpxml-artifact");
    assert.equal(payload.preflight.processMode, "headless");
    assert.equal(payload.preflight.backend, "final-cut-session");
    assert.equal(payload.preflight.capabilities.canonicalDocument.artifactWrite.backend, "fcpxml-document");
    assert.equal(payload.preflight.capabilities.editing.compositeTransactions.available, true);
    assert.equal(payload.preflight.capabilities.editing.compositeTransactions.backend, "fcpxml-document");
    assert.equal(payload.preflight.capabilities.editing.compositeTransactions.guarantee, "verified");
    assert.equal(payload.preflight.capabilities.editing.titlePlacement.available, false);
    assert.match(payload.preflight.capabilities.editing.pictureInPicture.unavailableReason, /unavailable/);
    assert.match(payload.preflight.capabilities.editing.masking.unavailableReason, /unavailable/);
    assert.equal(payload.preflight.capabilities.analyzers.speechTranscribe.available, false);
    assert.match(payload.preflight.capabilities.analyzers.audioLoudness.unavailableReason, /unavailable/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("editor inspection distinguishes fixture, metadata-only, canonical-live, and native-write modes", async () => {
  const fixture = await inspectWithMcp(new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-fixture",
    projectName: "Fixture",
    timelineId: "sequence-fixture",
    timelineName: "Main",
    clips: [],
  })));
  assert.equal(fixture.preflight.mode, "fixture");
  assert.equal(fixture.preflight.documentMode, "fixture");

  const metadataCapabilities = {
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
  const metadataLive = new FinalCutLiveAdapter({
    request: async (request) => ({
      version: 1,
      id: request.id,
      ok: true,
      result: {
        identity: { name: "Final Cut Pro", version: "test", backend: "workflow-extension-ipc" },
        capabilities: metadataCapabilities,
      },
    }),
  });
  const metadata = await inspectWithMcp(new AgentVideoRuntime(metadataLive), { processMode: "headless" });
  assert.equal(metadata.preflight.mode, "metadata-only");
  assert.equal(metadata.preflight.documentMode, "metadata-only");
  assert.equal(metadata.preflight.processMode, "headless");
  assert.equal(metadata.preflight.capabilities.connection.status.backend, "workflow-extension-ipc");

  const canonicalLive = await inspectWithMcp(new AgentVideoRuntime(new FinalCutLiveAdapter({
    request: async (request) => ({
      version: 1,
      id: request.id,
      ok: true,
      result: {
        identity: { name: "Final Cut Pro", version: "test", backend: "canonical-live-ipc" },
        capabilities: {
          ...metadataCapabilities,
          editor: {
            ...metadataCapabilities.editor,
            projectRead: true,
            timelineSnapshotRead: true,
            projectCatalogRead: true,
            projectSelection: true,
          },
        },
      },
    }),
  })));
  assert.equal(canonicalLive.preflight.mode, "canonical-live");
  assert.equal(canonicalLive.preflight.documentMode, "canonical-live");

  const native = await inspectWithMcp(new AgentVideoRuntime(new FinalCutLiveAdapter({
    request: async (request) => ({
      version: 1,
      id: request.id,
      ok: true,
      result: {
        identity: { name: "Final Cut Pro", version: "test", backend: "workflow-extension-ipc" },
        capabilities: metadataCapabilities,
      },
    }),
  })), {
    processMode: "headed",
    nativeEditor: {
      capabilities: () => ({
        selectionEdit: true,
        undo: true,
        mediaLibrarySearch: false,
        mediaImport: false,
        mediaSelection: false,
        mediaAppendSelected: false,
        timelineOccurrenceLocate: false,
        bladeAtPlayhead: false,
        deleteRange: false,
        trimToDuration: false,
        mediaAppend: false,
        mediaInsert: false,
        titlePlacement: false,
        timelineFocus: false,
        requiresAccessibility: true,
        requiresFinalCutFrontmost: true,
      }),
    } as never,
  });
  assert.equal(native.preflight.mode, "native-write");
  assert.equal(native.preflight.documentMode, "metadata-only");
  assert.equal(native.preflight.processMode, "headed");
  assert.equal(native.preflight.capabilities.native.selectionWrite.backend, "final-cut-accessibility");
  assert.equal(native.preflight.capabilities.native.selectionWrite.guarantee, "native-verified");
});
