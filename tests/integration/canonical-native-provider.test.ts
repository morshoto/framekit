import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  buildFinalCutCanonicalExportScript,
  createFinalCutNativeTargetResolver,
  FinalCutCanonicalSnapshotSource,
  FinalCutCanonicalNativeProvider,
  FinalCutSessionAdapter,
  type FinalCutBackgroundCatalogProvider,
  type CanonicalNativeTargetResolver,
  type CanonicalNativeMutationPort,
} from "@framekit/final-cut";
import type {
  ContextRevision,
  EditorChange,
  EditorIdentity,
  EditorLiveState,
  ProjectSnapshot,
} from "@framekit/runtime";
import { AgentVideoRuntime as Runtime } from "@framekit/runtime";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

const identity: EditorIdentity = {
  name: "Final Cut Pro",
  version: "10.7.1",
  backend: "workflow-extension-ipc",
};

function snapshot(name: string): ProjectSnapshot {
  return {
    projectId: "final-cut:project:project-1",
    projectName: "Canonical E2E",
    timeline: {
      id: "final-cut:sequence:sequence-1",
      name: "Canonical E2E",
      duration: 4,
      durationTime: { value: "96", timescale: "24" },
      frameDuration: { value: "1", timescale: "24" },
      clips: [{
        id: "final-cut:occurrence:clip-1",
        mediaId: "final-cut:media:media-1",
        name,
        start: 0,
        duration: 4,
        track: 0,
        startTime: { value: "0", timescale: "24" },
        durationTime: { value: "96", timescale: "24" },
      }],
      storyElements: [{
        id: "final-cut:occurrence:clip-1",
        kind: "asset-clip",
        start: 0,
        duration: 4,
        startTime: { value: "0", timescale: "24" },
        durationTime: { value: "96", timescale: "24" },
        lane: 0,
        mediaId: "final-cut:media:media-1",
      }],
      markers: [],
      captions: [],
    },
    media: [{ mediaId: "final-cut:media:media-1", source: "/tmp/clip.mov" }],
    revision: { id: "source-revision", sequence: 0, timestamp: new Date(0).toISOString() },
  };
}

function markerSnapshots(): { before: ProjectSnapshot; after: ProjectSnapshot } {
  const before = snapshot("Interview");
  const after = structuredClone(before);
  after.timeline.markers = [{
    id: "marker-1",
    start: 1,
    duration: 0.5,
    name: "Review",
    startTime: { value: "24", timescale: "24" },
    durationTime: { value: "12", timescale: "24" },
  }];
  return { before, after };
}

function gainSnapshots(): { before: ProjectSnapshot; after: ProjectSnapshot } {
  const before = snapshot("Dialogue");
  before.timeline.clips[0] = { ...before.timeline.clips[0]!, gainDb: 0 };
  const after = structuredClone(before);
  after.timeline.clips[0] = { ...after.timeline.clips[0]!, gainDb: 3 };
  return { before, after };
}

function rippleSnapshots(): { before: ProjectSnapshot; after: ProjectSnapshot } {
  const before = snapshot("Interview");
  before.timeline.duration = 6;
  before.timeline.durationTime = { value: "144", timescale: "24" };
  before.timeline.clips[0] = {
    ...before.timeline.clips[0]!,
    duration: 4,
    durationTime: { value: "96", timescale: "24" },
  };
  before.timeline.storyElements[0] = {
    ...before.timeline.storyElements[0]!,
    duration: 4,
    durationTime: { value: "96", timescale: "24" },
  };
  before.timeline.clips.push({
    id: "final-cut:occurrence:clip-2",
    mediaId: "final-cut:media:media-1",
    name: "B-roll",
    start: 4,
    duration: 2,
    track: 0,
    startTime: { value: "96", timescale: "24" },
    durationTime: { value: "48", timescale: "24" },
  });
  before.timeline.storyElements.push({
    id: "final-cut:occurrence:clip-2",
    kind: "asset-clip",
    start: 4,
    duration: 2,
    startTime: { value: "96", timescale: "24" },
    durationTime: { value: "48", timescale: "24" },
    lane: 0,
    mediaId: "final-cut:media:media-1",
  });
  const after = structuredClone(before);
  after.timeline.duration = 4;
  after.timeline.durationTime = { value: "96", timescale: "24" };
  after.timeline.clips = [
    { ...after.timeline.clips[0]!, duration: 2, durationTime: { value: "48", timescale: "24" } },
    { ...after.timeline.clips[1]!, start: 2, startTime: { value: "48", timescale: "24" } },
  ];
  after.timeline.storyElements = [
    { ...after.timeline.storyElements[0]!, duration: 2, durationTime: { value: "48", timescale: "24" } },
    { ...after.timeline.storyElements[1]!, start: 2, startTime: { value: "48", timescale: "24" } },
  ];
  return { before, after };
}

function liveState(): EditorLiveState {
  return {
    project: { id: "final-cut:project:project-1", name: "Canonical E2E" },
    sequence: {
      id: "final-cut:sequence:sequence-1",
      name: "Canonical E2E",
      startTime: { value: "0", timescale: "24" },
      duration: { value: "96", timescale: "24" },
      frameDuration: { value: "1", timescale: "24" },
    },
    revision: { id: "live-revision", sequence: 1, timestamp: new Date(1).toISOString() },
  };
}

function liveWithoutBackgroundCatalog() {
  return {
    getIdentity: async () => identity,
    readLiveState: async () => structuredClone(liveState()),
    liveChangesSince: async () => [],
  };
}

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { text?: unknown } | undefined;
  assert.ok(first);
  assert.equal(typeof first.text, "string");
  return first.text as string;
}

function providerFor(
  snapshots: Array<ProjectSnapshot | Error>,
  calls: string[],
  resolveTarget: CanonicalNativeTargetResolver = async () => {},
  activeState: EditorLiveState = liveState(),
  backgroundCatalog?: FinalCutBackgroundCatalogProvider,
  nativeOverrides: Partial<CanonicalNativeMutationPort> = {},
) {
  const native = {
    renameSelectedClip: async () => {
      calls.push("edit");
      return { operationId: "native-operation-1", undoAvailable: true };
    },
    undo: async () => {
      calls.push("undo");
      return { undone: true, verification: { verified: true, detail: "restored" } };
    },
    ...nativeOverrides,
  };
  const live = {
    getIdentity: async () => identity,
    readLiveState: async () => structuredClone(activeState),
    liveChangesSince: async (_revision: ContextRevision, _waitMs?: number): Promise<EditorChange[]> => [],
  };
  return new FinalCutCanonicalNativeProvider({
    live,
    native,
    readSnapshot: async () => {
      const next = snapshots.shift();
      if (!next) throw new Error("snapshot queue exhausted");
      if (next instanceof Error) throw next;
      return structuredClone(next);
    },
    resolveTarget,
    ...(backgroundCatalog ? { backgroundCatalog } : {}),
  });
}

test("canonical native provider exposes one explicit active project and sequence", async () => {
  const provider = providerFor([snapshot("Original")], [], undefined, liveState(), {
    listProjects: async () => ({
      projects: [{
        id: "final-cut:project:project-1",
        name: "Canonical E2E",
        sequences: [{ id: "final-cut:sequence:sequence-1", name: "Canonical E2E" }],
      }],
      activeProjectId: "final-cut:project:project-1",
      activeSequenceId: "final-cut:sequence:sequence-1",
    }),
  });

  const catalog = await provider.listProjects();

  assert.equal(catalog.projects.length, 1);
  assert.equal(catalog.activeProjectId, "final-cut:project:project-1");
  assert.equal(catalog.activeSequenceId, "final-cut:sequence:sequence-1");
  const capabilities = await provider.getCapabilities();
  assert.equal(capabilities.editor.canonicalTimelineMode, "metadata-only");
  assert.equal(capabilities.editor.projectCatalogRead, true);
  assert.equal(capabilities.editor.projectSelection, false);
  assert.equal(capabilities.editor.projectRead, false);
  assert.equal(capabilities.editor.timelineWrite, false);
});

test("canonical project listing requires a background catalog", async () => {
  let snapshotReads = 0;
  const provider = new FinalCutCanonicalNativeProvider({
    live: liveWithoutBackgroundCatalog(),
    native: {
      renameSelectedClip: async () => ({ operationId: "native-operation-1", undoAvailable: true }),
      undo: async () => ({ undone: true, verification: { verified: true } }),
    },
    readSnapshot: async () => {
      snapshotReads += 1;
      throw new Error("headed Export XML must not run for project.list");
    },
    resolveTarget: async () => undefined,
  });

  const capabilities = await provider.getCapabilities();
  assert.equal(capabilities.editor.projectCatalogRead, false);
  assert.equal(capabilities.editor.canonicalTimelineMode, "metadata-only");
  await assert.rejects(
    provider.listProjects(),
    /CAPABILITY_UNAVAILABLE: project\.list requires editor\.projectCatalogRead: background project catalog is unavailable; canonical timeline snapshot export \(File > Export XML\) requires a headed Final Cut UI/,
  );
  assert.equal(snapshotReads, 0);
});

test("canonical capabilities fail closed when Export XML snapshot is unavailable", async () => {
  const provider = providerFor([
    new Error("FINAL_CUT_CANONICAL_EXPORT_WINDOW_UNAVAILABLE: Export XML window did not appear"),
  ], [], undefined, liveState(), {
    listProjects: async () => ({
      projects: [{
        id: "final-cut:project:project-1",
        name: "Canonical E2E",
        sequences: [{ id: "final-cut:sequence:sequence-1", name: "Canonical E2E" }],
      }],
      activeProjectId: "final-cut:project:project-1",
      activeSequenceId: "final-cut:sequence:sequence-1",
    }),
  });

  const capabilities = await provider.getCapabilities();

  assert.equal(capabilities.editor.canonicalTimelineMode, "metadata-only");
  assert.equal(capabilities.editor.projectRead, false);
  assert.equal(capabilities.editor.timelineSnapshotRead, false);
  assert.equal(capabilities.editor.timelineWrite, false);
  assert.equal(capabilities.editor.readAfterWrite, false);
  assert.equal(capabilities.editor.rollback, false);
  assert.equal(capabilities.editor.projectCatalogRead, true);
  assert.deepEqual(capabilities.families?.canonicalDocument.read, {
    available: false,
    backend: "final-cut-native-canonical",
    guarantee: "none",
    unavailableReason: "canonical snapshot provider unavailable: FINAL_CUT_CANONICAL_EXPORT_WINDOW_UNAVAILABLE: Export XML window did not appear",
  });
  assert.deepEqual(capabilities.families?.canonicalDocument.write, {
    available: false,
    backend: "final-cut-native-canonical",
    guarantee: "none",
    unavailableReason: "canonical snapshot provider unavailable: FINAL_CUT_CANONICAL_EXPORT_WINDOW_UNAVAILABLE: Export XML window did not appear",
  });
});

test("MCP project.list explains the headed fallback is unavailable", async () => {
  let snapshotReads = 0;
  const provider = new FinalCutCanonicalNativeProvider({
    live: liveWithoutBackgroundCatalog(),
    native: {
      renameSelectedClip: async () => ({ operationId: "native-operation-1", undoAvailable: true }),
      undo: async () => ({ undone: true, verification: { verified: true } }),
    },
    readSnapshot: async () => {
      snapshotReads += 1;
      throw new Error("headed Export XML must not run for project.list");
    },
    resolveTarget: async () => undefined,
  });
  const server = createMcpServer(new Runtime(new FinalCutSessionAdapter({ live: provider })));
  const client = new Client({ name: "canonical-project-list-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const editor = JSON.parse(textFrom(await client.callTool({ name: "editor.inspect", arguments: {} })));
    assert.equal(editor.capabilities.editor.projectCatalogRead, false);
    assert.equal(editor.capabilities.editor.canonicalTimelineMode, "metadata-only");
    const result = await client.callTool({ name: "project.list", arguments: {} });
    assert.equal(result.isError, true);
    const error = JSON.parse(textFrom(result)) as {
      operation: string;
      capability: string;
      unavailableReason: string;
    };
    assert.equal(error.operation, "project.list");
    assert.equal(error.capability, "editor.projectCatalogRead");
    assert.equal(error.unavailableReason, "project catalog is unavailable");
    assert.equal(snapshotReads, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("canonical native provider previews and applies its supported timeline transaction", async () => {
  const calls: string[] = [];
  const provider = providerFor([
    snapshot("Original"),
    snapshot("Original"),
    snapshot("Original"),
    snapshot("Original"),
    snapshot("Renamed"),
  ], calls);
  const before = await provider.readProject();
  const operation = {
    type: "rename-clip" as const,
    clipId: "final-cut:occurrence:clip-1",
    name: "Renamed",
  };

  const preview = await provider.previewTransaction([operation], before.revision);

  assert.equal(preview.timeline.clips[0]?.name, "Renamed");
  assert.deepEqual(await provider.readProject(), before);
  assert.deepEqual(calls, []);

  await provider.applyTransaction([operation], before.revision);

  assert.deepEqual(calls, ["edit"]);
});

test("canonical native provider previews and applies a revision-guarded ripple delete", async () => {
  const { before: original, after: deleted } = rippleSnapshots();
  const calls: string[] = [];
  const provider = providerFor(
    [original, original, original, original, deleted, deleted, deleted, original],
    calls,
    undefined,
    liveState(),
    undefined,
    {
      rippleDeleteRange: async (range) => {
        calls.push(`delete:${range.start.value}/${range.start.timescale}-${range.end.value}/${range.end.timescale}`);
        return { operationId: "native-delete-1", undoAvailable: true };
      },
    },
  );
  const before = await provider.readProject();
  const operation = {
    type: "ripple-delete" as const,
    timelineId: before.timeline.id,
    range: {
      start: 2,
      end: 4,
      startTime: { value: "48", timescale: "24" },
      durationTime: { value: "48", timescale: "24" },
    },
    candidateId: "filler-1",
    reason: "remove verified filler",
  };

  const preview = await provider.previewTransaction([operation], before.revision);

  assert.equal(preview.timeline.duration, 4);
  assert.equal(preview.timeline.clips[0]?.duration, 2);
  assert.equal(preview.timeline.clips[1]?.start, 2);
  assert.deepEqual(await provider.readProject(), before);
  assert.deepEqual(calls, []);

  await provider.applyTransaction([operation], before.revision);

  assert.deepEqual(calls, ["delete:48/24-4/1"]);
  await provider.restore(before, (await provider.readProject()).revision);
  assert.deepEqual(calls, ["delete:48/24-4/1", "undo"]);
});

test("canonical native provider rejects middle-of-clip ripple deletes", async () => {
  const calls: string[] = [];
  const provider = providerFor([snapshot("Interview"), snapshot("Interview")], calls);
  const before = await provider.readProject();
  const operation = {
    type: "ripple-delete" as const,
    timelineId: before.timeline.id,
    range: {
      start: 1,
      end: 2,
      startTime: { value: "24", timescale: "24" },
      durationTime: { value: "24", timescale: "24" },
    },
    candidateId: "filler-middle",
    reason: "remove verified filler",
  };

  await assert.rejects(
    provider.previewTransaction([operation], before.revision),
    /INVALID_OPERATION: ripple-delete middle-of-clip range requires a source-preserving split/,
  );
  assert.deepEqual(calls, []);
});

test("canonical native provider rejects collateral ripple-delete readback changes", async () => {
  const { before: original, after: deleted } = rippleSnapshots();
  const collateral = structuredClone(deleted);
  collateral.timeline.markers.push({ id: "unexpected-marker", start: 1, duration: 0, name: "Collateral" });
  const calls: string[] = [];
  const provider = providerFor(
    [original, original, collateral, original],
    calls,
    undefined,
    liveState(),
    undefined,
    {
      rippleDeleteRange: async () => {
        calls.push("delete");
        return { operationId: "native-delete-collateral", undoAvailable: true };
      },
    },
  );
  const before = await provider.readProject();
  const operation = {
    type: "ripple-delete" as const,
    timelineId: before.timeline.id,
    range: {
      start: 2,
      end: 4,
      startTime: { value: "48", timescale: "24" },
      durationTime: { value: "48", timescale: "24" },
    },
    candidateId: "filler-1",
    reason: "remove verified filler",
  };

  await assert.rejects(
    provider.apply(operation, before.revision),
    /ripple-delete readback differed from the exact canonical projection/,
  );
  assert.deepEqual(calls, ["delete", "undo"]);
});

test("canonical native provider previews and applies a revision-guarded marker", async () => {
  const { before: original, after: marked } = markerSnapshots();
  const calls: string[] = [];
  const provider = providerFor(
    [original, original, original, original, marked, marked, marked, original],
    calls,
    undefined,
    liveState(),
    undefined,
    {
      addMarkerAtTime: async (marker) => {
        calls.push(`marker:${marker.start.value}/${marker.start.timescale}:${marker.duration.value}/${marker.duration.timescale}`);
        return { operationId: "native-marker-1", undoAvailable: true };
      },
    },
  );
  const before = await provider.readProject();
  const operation = {
    type: "add-marker" as const,
    timelineId: before.timeline.id,
    marker: {
      id: "marker-1",
      start: 1,
      duration: 0.5,
      name: "Review",
      startTime: { value: "24", timescale: "24" },
      durationTime: { value: "12", timescale: "24" },
    },
    baseRevision: before.revision,
  };

  const preview = await provider.previewTransaction([operation], before.revision);

  assert.equal(preview.timeline.markers[0]?.name, "Review");
  assert.deepEqual(await provider.readProject(), before);
  assert.deepEqual(calls, []);

  await provider.applyTransaction([operation], before.revision);

  assert.deepEqual(calls, ["marker:24/24:12/24"]);
  await provider.restore(before, (await provider.readProject()).revision);
  assert.deepEqual(calls, ["marker:24/24:12/24", "undo"]);
});

test("canonical native provider previews and applies a revision-guarded gain", async () => {
  const { before: original, after: gained } = gainSnapshots();
  const calls: string[] = [];
  const provider = providerFor(
    [original, original, original, original, gained, gained, gained, original],
    calls,
    undefined,
    liveState(),
    undefined,
    {
      setSelectedClipGain: async (gainDb) => {
        calls.push(`gain:${gainDb}`);
        return { operationId: "native-gain-1", undoAvailable: true };
      },
    },
  );
  const before = await provider.readProject();
  const operation = {
    type: "set-gain" as const,
    clipId: before.timeline.clips[0]!.id,
    gainDb: 3,
    baseRevision: before.revision,
  };

  const preview = await provider.previewTransaction([operation], before.revision);

  assert.equal(preview.timeline.clips[0]?.gainDb, 3);
  assert.deepEqual(await provider.readProject(), before);
  assert.deepEqual(calls, []);

  await provider.applyTransaction([operation], before.revision);

  assert.deepEqual(calls, ["gain:3"]);
  await provider.restore(before, (await provider.readProject()).revision);
  assert.deepEqual(calls, ["gain:3", "undo"]);
});

test("canonical native provider rejects unbounded gains before native mutation", async () => {
  for (const gainDb of [-7, 7, Number.POSITIVE_INFINITY]) {
    const calls: string[] = [];
    const provider = providerFor(
      [snapshot("Dialogue"), snapshot("Dialogue")],
      calls,
      undefined,
      liveState(),
      undefined,
      {
        setSelectedClipGain: async (gain) => {
          calls.push(`gain:${gain}`);
          return { operationId: "unexpected-gain", undoAvailable: true };
        },
      },
    );
    const before = await provider.readProject();

    await assert.rejects(
      provider.apply({
        type: "set-gain",
        clipId: before.timeline.clips[0]!.id,
        gainDb,
        baseRevision: before.revision,
      }, before.revision),
      gainDb === Number.POSITIVE_INFINITY
        ? /INVALID_OPERATION: gain must be finite/
        : /INVALID_OPERATION: gain must be between -6 and 6 dB/,
    );
    assert.deepEqual(calls, []);
  }
});

test("canonical native provider rejects whitespace-only direct renames before mutation", async () => {
  const calls: string[] = [];
  const provider = providerFor([snapshot("Original"), snapshot("Original")], calls);
  const before = await provider.readProject();

  await assert.rejects(
    provider.apply({
      type: "rename-clip",
      clipId: "final-cut:occurrence:clip-1",
      name: "   ",
      baseRevision: before.revision,
    }, before.revision),
    /INVALID_OPERATION: clip name cannot be empty/,
  );
  assert.deepEqual(calls, []);
});

test("canonical native provider rejects stale targets before native mutation", async () => {
  const calls: string[] = [];
  const provider = providerFor([snapshot("Original"), snapshot("Original")], calls);
  const before = await provider.readProject();

  await assert.rejects(
    provider.apply({
      type: "rename-clip",
      clipId: "final-cut:occurrence:clip-1",
      name: "Renamed",
      baseRevision: { ...before.revision, id: "stale" },
    }, { ...before.revision, id: "stale" }),
    /STALE_CONTEXT/,
  );
  assert.deepEqual(calls, []);
});

test("canonical native provider verifies native edit and restores its canonical digest", async () => {
  const calls: string[] = [];
  const provider = providerFor([
    snapshot("Original"),
    snapshot("Original"),
    snapshot("Renamed"),
    snapshot("Renamed"),
    snapshot("Original"),
  ], calls);
  const before = await provider.readProject();
  const afterRevision = await provider.apply({
    type: "rename-clip",
    clipId: "final-cut:occurrence:clip-1",
    name: "Renamed",
    baseRevision: before.revision,
  }, before.revision);

  assert.ok(afterRevision.sequence > before.revision.sequence);
  assert.deepEqual(calls, ["edit"]);
  await provider.restore(before, afterRevision);
  assert.deepEqual(calls, ["edit", "undo"]);
});

test("canonical native provider undoes failed post-edit verification", async () => {
  const cases: Array<{ label: string; after: ProjectSnapshot | Error; name: string; expected: RegExp }> = [
    { label: "read error", after: new Error("export read failed"), name: "Renamed", expected: /export read failed/ },
    { label: "name mismatch", after: snapshot("Unexpected"), name: "Renamed", expected: /renamed occurrence was not read back/ },
    { label: "unchanged digest", after: snapshot("Original"), name: "Original", expected: /native edit did not change the canonical digest/ },
  ];
  for (const { label, after, name, expected } of cases) {
    const calls: string[] = [];
    const provider = providerFor([snapshot("Original"), snapshot("Original"), after, snapshot("Original")], calls);
    const before = await provider.readProject();

    await assert.rejects(
      provider.apply({
        type: "rename-clip",
        clipId: "final-cut:occurrence:clip-1",
        name,
        baseRevision: before.revision,
      }, before.revision),
      expected,
      label,
    );
    assert.deepEqual(calls, ["edit", "undo"], label);
  }
});

test("canonical native provider rejects ambiguous occurrence bindings before edit", async () => {
  const calls: string[] = [];
  const resolveTarget: CanonicalNativeTargetResolver = async () => {
    throw new Error("AMBIGUOUS_PROJECT_TARGET: occurrence binding is not unique");
  };
  const provider = providerFor([snapshot("Original"), snapshot("Original")], calls, resolveTarget);
  const before = await provider.readProject();

  await assert.rejects(
    provider.apply({
      type: "rename-clip",
      clipId: "final-cut:occurrence:clip-1",
      name: "Renamed",
      baseRevision: before.revision,
    }, before.revision),
    /AMBIGUOUS_PROJECT_TARGET/,
  );
  assert.deepEqual(calls, []);
});

test("canonical native provider rejects same-name targets with different live IDs", async () => {
  for (const kind of ["project", "sequence"] as const) {
    const active = liveState();
    if (kind === "project") {
      active.project = { ...active.project!, id: "final-cut:project:other" };
    } else {
      active.sequence = { ...active.sequence!, id: "final-cut:sequence:other" };
    }
    const provider = providerFor([snapshot("Original")], [], undefined, active);

    await assert.rejects(
      provider.readProject(),
      new RegExp(`TARGET_MISMATCH: active ${kind} identity`),
      kind,
    );
  }
});

test("canonical Final Cut export is driven by the active timeline UI", () => {
  const script = buildFinalCutCanonicalExportScript("/tmp/framekit-canonical.fcpxml");

  assert.match(script, /File/);
  assert.match(script, /Export/);
  assert.match(script, /XML/);
  assert.match(script, /framekit-canonical\.fcpxml/);
  const activationIndex = script.indexOf("set frontmost to true");
  const frontmostGuardIndex = script.indexOf("if not frontmost then error");
  assert.ok(activationIndex >= 0);
  assert.ok(frontmostGuardIndex > activationIndex);
  assert.doesNotMatch(script, /FRAMEKIT_FCPXML_PATH/);
});

test("canonical Final Cut export waits for a complete FCPXML file", async () => {
  const completeDocument = "<?xml version=\"1.0\"?><fcpxml><resources/><library><event><project uid=\"project-export\" name=\"Exported\"><sequence uid=\"sequence-export\" name=\"Main\" duration=\"1s\"><spine/></sequence></project></event></library></fcpxml>";
  let finishExport: Promise<void> | undefined;
  const source = new FinalCutCanonicalSnapshotSource({
    exportTimeoutMs: 500,
    pollIntervalMs: 10,
    executor: async (script) => {
      const match = script.match(/set value of text field 1 of pathSheet to "([^"]+)"/);
      assert.ok(match?.[1]);
      const exportPath = match[1];
      const partialDocument = completeDocument.slice(0, Math.floor(completeDocument.length / 2));
      await writeFile(exportPath, partialDocument);
      finishExport = new Promise((resolve) => {
        setTimeout(() => {
          void appendFile(exportPath, completeDocument.slice(partialDocument.length))
            .catch(() => undefined)
            .finally(resolve);
        }, 40);
      });
      return "canonical-export-requested";
    },
  });

  let project: ProjectSnapshot;
  try {
    project = await source.readSnapshot();
  } finally {
    await finishExport;
  }
  assert.equal(project!.projectName, "Exported");
});

test("canonical target resolver requires one exact native occurrence", async () => {
  const native = {
    searchMedia: async () => [{
      handle: "media-handle",
      name: "clip.mov",
      sourceIdentity: "browser-source-1",
    }],
    locateOccurrence: async () => ({
      status: "unique" as const,
      occurrences: [{
        handle: "occurrence-handle",
        mediaHandle: "media-handle",
        name: "Original",
        identity: "native-occurrence-1",
        start: "0/24",
        duration: "96/24",
        sequenceId: "final-cut:sequence:sequence-1",
      }],
    }),
  };

  const resolver = createFinalCutNativeTargetResolver(native);
  await resolver(snapshot("Original").timeline.clips[0]!, snapshot("Original"));
});

test("canonical target resolver rejects ambiguous native media", async () => {
  const native = {
    searchMedia: async () => [
      { handle: "media-1", name: "clip.mov", sourceIdentity: "browser-source-1" },
      { handle: "media-2", name: "clip.mov", sourceIdentity: "browser-source-2" },
    ],
    locateOccurrence: async () => ({ status: "none" as const, occurrences: [] }),
  };
  const resolver = createFinalCutNativeTargetResolver(native);

  await assert.rejects(
    resolver(snapshot("Original").timeline.clips[0]!, snapshot("Original")),
    /AMBIGUOUS_PROJECT_TARGET/,
  );
});

test("canonical target resolver rejects native coordinate drift", async () => {
  const native = {
    searchMedia: async () => [{
      handle: "media-handle",
      name: "clip.mov",
      sourceIdentity: "browser-source-1",
    }],
    locateOccurrence: async () => ({
      status: "unique" as const,
      occurrences: [{
        handle: "occurrence-handle",
        mediaHandle: "media-handle",
        name: "Original",
        start: "24/24",
        duration: "96/24",
      }],
    }),
  };
  const resolver = createFinalCutNativeTargetResolver(native);

  await assert.rejects(
    resolver(snapshot("Original").timeline.clips[0]!, snapshot("Original")),
    /TARGET_MISMATCH/,
  );
});

test("canonical target resolver rejects coordinate-only native occurrences", async () => {
  const native = {
    searchMedia: async () => [{
      handle: "media-handle",
      name: "clip.mov",
      sourceIdentity: "browser-source-1",
    }],
    locateOccurrence: async () => ({
      status: "unique" as const,
      occurrences: [{
        handle: "occurrence-handle",
        mediaHandle: "media-handle",
        name: "Original",
        start: "0/24",
        duration: "96/24",
        sequenceId: "final-cut:sequence:sequence-1",
      }],
    }),
  };
  const resolver = createFinalCutNativeTargetResolver(native);

  await assert.rejects(
    resolver(snapshot("Original").timeline.clips[0]!, snapshot("Original")),
    /TARGET_MISMATCH: native occurrence has no stable identity/,
  );
});

test("canonical provider rejects media identity drift during read-after-write", async () => {
  const calls: string[] = [];
  const drifted = snapshot("Renamed");
  drifted.timeline.clips[0]!.mediaId = "final-cut:media:drifted";
  const provider = providerFor([
    snapshot("Original"),
    snapshot("Original"),
    drifted,
    snapshot("Original"),
  ], calls);
  const before = await provider.readProject();

  await assert.rejects(
    provider.apply({
      type: "rename-clip",
      clipId: "final-cut:occurrence:clip-1",
      name: "Renamed",
      baseRevision: before.revision,
    }, before.revision),
    /TARGET_MISMATCH: read-after-write changed media/,
  );
  assert.deepEqual(calls, ["edit", "undo"]);
});
