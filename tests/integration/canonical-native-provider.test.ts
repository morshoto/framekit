import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  buildFinalCutCanonicalExportScript,
  createFinalCutNativeTargetResolver,
  FinalCutCanonicalExportError,
  FinalCutCanonicalSnapshotSource,
  FinalCutCanonicalNativeProvider,
  FileCanonicalRecoveryGuard,
  FinalCutSessionAdapter,
  parseFinalCutCanonicalExportResult,
  type FinalCutBackgroundCatalogProvider,
  type CanonicalNativeTargetResolver,
  type CanonicalNativeMutationPort,
} from "@framekit/final-cut";
import type {
  ContextRevision,
  EditorChange,
  EditorIdentity,
  EditorPort,
  EditorLiveState,
  ProjectSelectionResult,
  ProjectSnapshot,
  RuntimeCapabilities,
} from "@framekit/runtime";
import { AgentVideoRuntime as Runtime, canonicalSnapshotDigest, createTimelineIrFromProjectSnapshot } from "@framekit/runtime";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";
import { ProjectService } from "../../packages/runtime/src/application/project-service.js";
import { ContextEngine } from "../../packages/runtime/src/context/context-engine.js";

const identity: EditorIdentity = {
  name: "Final Cut Pro",
  version: "10.7.1",
  backend: "workflow-extension-ipc",
};

function canonicalExportPath(script: string): string {
  const directLayoutField = script.match(
    /set value of pathField to "([^"]+)"[\s\S]*?set value of text field 2 of saveRoot to "([^"]+)"/,
  );
  if (directLayoutField?.[1] && directLayoutField?.[2]) return join(directLayoutField[1], directLayoutField[2]);
  const directNameField = script.match(
    /keystroke "a" using \{command down\}[\s\S]*?keystroke "([^\"]+)"[\s\S]*?set value of nameField to "([^\"]+)"/,
  );
  if (directNameField?.[1] && directNameField?.[2]) return join(directNameField[1], directNameField[2]);
  const fields = script.match(
    /keystroke "a" using \{command down\}[\s\S]*?keystroke "([^"]+)"[\s\S]*?keystroke "a" using \{command down\}[\s\S]*?keystroke "([^"]+)"/,
  );
  assert.ok(fields?.[1]);
  assert.ok(fields?.[2]);
  return join(fields[1], fields[2]);
}

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
  resolveTarget: CanonicalNativeTargetResolver = Object.assign(async () => {}, { sourceBindingAvailable: true }),
  activeState: EditorLiveState = liveState(),
  backgroundCatalog?: FinalCutBackgroundCatalogProvider,
  nativeOverrides: Partial<CanonicalNativeMutationPort> = {},
  recoveryGuard?: { assertClear(): Promise<void>; begin(checkpoint: { projectId: string; sequenceId: string; baseRevision: string; beforeDigest: string; operation: string; expectedRestoreDigest?: string }): Promise<void>; complete(): Promise<void> },
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
    ...(recoveryGuard ? { recoveryGuard } : {}),
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
  assert.equal(capabilities.editor.canonicalTimelineMode, "canonical-read");
  assert.equal(capabilities.editor.projectCatalogRead, true);
  assert.equal(capabilities.editor.projectSelection, true);
  assert.equal(capabilities.editor.projectSelectionMode, "active-target-only");
  assert.equal(capabilities.editor.projectRead, true);
  assert.equal(capabilities.editor.timelineSnapshotRead, true);
  assert.equal(capabilities.editor.timelineWrite, false);
  assert.equal(capabilities.editor.readAfterWrite, false);
  assert.equal(capabilities.editor.rollback, false);
  assert.equal(capabilities.families?.canonicalDocument.read?.guarantee, "canonical-read");
  assert.equal(capabilities.families?.canonicalDocument.write?.available, false);
  const selected = await provider.selectProject({ projectId: "final-cut:project:project-1" });
  assert.deepEqual(selected.observedActiveTarget, {
    projectId: "final-cut:project:project-1", sequenceId: "final-cut:sequence:sequence-1",
  });
  await assert.rejects(provider.selectProject({ projectId: "other" }), /TARGET_MISMATCH/);
});

test("active-only rebind rejects a stale snapshot without exporting again", async () => {
  const active = liveState();
  const provider = providerFor([snapshot("Original")], [], undefined, active, {
    listProjects: async () => ({
      projects: [{ id: "final-cut:project:project-1", name: "Canonical E2E", sequences: [
        { id: "final-cut:sequence:sequence-1", name: "Canonical E2E" },
      ] }],
      activeProjectId: "final-cut:project:project-1",
      activeSequenceId: "final-cut:sequence:sequence-1",
    }),
  });
  await provider.getCapabilities();
  assert.ok(active.revision);
  active.revision.id = "external-revision";
  await assert.rejects(
    provider.selectProject({ projectId: "final-cut:project:project-1" }),
    /CAPABILITY_UNAVAILABLE: active-target-only rebind requires a current canonical snapshot/,
  );
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

test("session selection capability requires an exposed selection method", async () => {
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
  const live = {
    getIdentity: () => provider.getIdentity(),
    getCapabilities: async () => {
      const capabilities = await provider.getCapabilities();
      return {
        ...capabilities,
        editor: {
          ...capabilities.editor,
          projectSelection: true,
          projectSelectionMode: "headed-only" as const,
        },
      };
    },
    readLiveState: () => provider.readLiveState(),
    liveChangesSince: (revision: ContextRevision, waitMs?: number) => provider.liveChangesSince(revision, waitMs),
  };
  const session = new FinalCutSessionAdapter({
    live,
    backgroundCatalog: {
      listProjects: async () => ({
        projects: [{
          id: "final-cut:project:project-1",
          name: "Canonical E2E",
          sequences: [{ id: "final-cut:sequence:sequence-1", name: "Canonical E2E" }],
        }],
        activeProjectId: "final-cut:project:project-1",
        activeSequenceId: "final-cut:sequence:sequence-1",
      }),
    },
  });

  const capabilities = await session.getCapabilities();
  const catalog = await session.listProjects();

  assert.equal(capabilities.editor.projectSelection, false);
  assert.equal(capabilities.editor.projectSelectionMode, "unavailable");
  assert.equal(catalog.provenance?.selection.available, false);
  assert.equal(catalog.provenance?.selection.mode, "unavailable");

  const claimedCapabilities = await provider.getCapabilities();
  const snapshotAdapter = {
    getCapabilities: async () => ({
      ...claimedCapabilities,
      editor: {
        ...claimedCapabilities.editor,
        projectSelection: true,
        projectSelectionMode: "headed-only" as const,
      },
    }),
  } as unknown as EditorPort;
  const snapshotCapabilities = await new FinalCutSessionAdapter({ snapshot: snapshotAdapter }).getCapabilities();

  assert.equal(snapshotCapabilities.editor.projectSelection, false);
  assert.equal(snapshotCapabilities.editor.projectSelectionMode, "unavailable");
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

test("canonical native provider previews and applies a revision-guarded trim", async () => {
  const calls: string[] = [];
  const original = snapshot("Original");
  const trimmed = structuredClone(original);
  trimmed.timeline.duration = 3;
  trimmed.timeline.durationTime = { value: "72", timescale: "24" };
  trimmed.timeline.clips[0] = {
    ...trimmed.timeline.clips[0]!,
    duration: 3,
    durationTime: { value: "72", timescale: "24" },
  };
  trimmed.timeline.storyElements[0] = {
    ...trimmed.timeline.storyElements[0]!,
    duration: 3,
    durationTime: { value: "72", timescale: "24" },
  };
  const native = {
    renameSelectedClip: async () => ({ operationId: "unused", undoAvailable: true }),
    trimSelectedClipToRange: async (range: { start: { value: string; timescale: string }; end: { value: string; timescale: string } }) => {
      calls.push(`trim:${range.start.value}/${range.start.timescale}-${range.end.value}/${range.end.timescale}`);
      return { operationId: "native-trim-1", undoAvailable: true };
    },
    undo: async () => {
      calls.push("undo");
      return { undone: true, verification: { verified: true } };
    },
  };
  const snapshots: ProjectSnapshot[] = [original, original, original, trimmed, trimmed, original];
  const provider = new FinalCutCanonicalNativeProvider({
    live: {
      getIdentity: async () => identity,
      readLiveState: async () => structuredClone(liveState()),
      liveChangesSince: async () => [],
    },
    native,
    readSnapshot: async () => {
      const next = snapshots.shift();
      if (!next) throw new Error("snapshot queue exhausted");
      return structuredClone(next);
      },
    resolveTarget: Object.assign(async () => undefined, { sourceBindingAvailable: true }),
  });
  const before = await provider.readProject();
  const operation = {
    type: "trim-clip" as const,
    clipId: before.timeline.clips[0]!.id,
    duration: 3,
    durationTime: { value: "72", timescale: "24" },
  };

  const preview = await provider.previewTransaction([operation], before.revision);

  assert.equal(preview.timeline.clips[0]?.duration, 3);
  assert.deepEqual(preview.timeline.clips[0]?.durationTime, operation.durationTime);
  assert.deepEqual(calls, []);

  const afterRevision = await provider.apply(operation, before.revision);

  assert.deepEqual(calls, ["trim:0/24-3/1"]);
  await provider.restore(before, afterRevision);
  assert.deepEqual(calls, ["trim:0/24-3/1", "undo"]);
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

test("canonical native provider reports timeline bounds for out-of-range ripple deletes", async () => {
  const { before: original } = rippleSnapshots();
  const calls: string[] = [];
  const provider = providerFor([original, original, original, original, original], calls);
  const before = await provider.readProject();

  for (const range of [{ start: -1, end: 1 }, { start: 5, end: 7 }]) {
    const operation = {
      type: "ripple-delete" as const,
      timelineId: before.timeline.id,
      range,
      candidateId: "out-of-bounds",
      reason: "reject invalid range",
    };
    await assert.rejects(
      provider.previewTransaction([operation], before.revision),
      new RegExp(`ripple-delete range \\[${range.start}, ${range.end}\\) must fit timeline bounds \\[0, 6\\)`),
    );
    assert.deepEqual(await provider.readProject(), before);
  }

  assert.deepEqual(calls, []);
});

test("trim and gain reject collateral readback changes and restore the baseline", async () => {
  const originalTrim = snapshot("Original");
  const trimmed = structuredClone(originalTrim);
  trimmed.timeline.duration = 3;
  trimmed.timeline.durationTime = { value: "72", timescale: "24" };
  trimmed.timeline.clips[0] = { ...trimmed.timeline.clips[0]!, duration: 3, durationTime: { value: "72", timescale: "24" } };
  trimmed.timeline.storyElements[0] = { ...trimmed.timeline.storyElements[0]!, duration: 3, durationTime: { value: "72", timescale: "24" } };
  const gain = gainSnapshots();
  const cases = [
    { label: "trim", before: originalTrim, after: trimmed, operation: { type: "trim-clip" as const, clipId: "final-cut:occurrence:clip-1", duration: 3, durationTime: { value: "72", timescale: "24" } } },
    { label: "gain", before: gain.before, after: gain.after, operation: { type: "set-gain" as const, clipId: "final-cut:occurrence:clip-1", gainDb: 3 } },
  ];
  for (const { label, before: original, after, operation } of cases) {
    const collateral = structuredClone(after);
    collateral.timeline.markers.push({ id: "unexpected-marker", start: 1, duration: 0, name: "Collateral" });
    const calls: string[] = [];
    const mutate = async () => { calls.push(label); return { operationId: `native-${label}`, undoAvailable: true }; };
    const provider = providerFor([original, original, collateral, original, original], calls, undefined, liveState(), undefined, {
      trimSelectedClipToRange: mutate, setSelectedClipGain: mutate,
    });
    const before = await provider.readProject();
    await assert.rejects(provider.apply(operation, before.revision), /FINAL_CUT_CANONICAL_READBACK_FAILED/, label);
    assert.deepEqual(calls, [label, "undo"], label);
    assert.equal(canonicalSnapshotDigest(await provider.readProject()), canonicalSnapshotDigest(before), label);
  }
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

test("direct marker edit rejects a duplicate marker identity before mutation", async () => {
  const original = markerSnapshots().after;
  const calls: string[] = [];
  const provider = providerFor([original, original, original, original], calls, undefined, liveState(), undefined, {
    addMarkerAtTime: async () => { calls.push("marker"); return { operationId: "native-marker", undoAvailable: true }; },
  });
  const before = await provider.readProject();
  await assert.rejects(provider.apply({
    type: "add-marker", timelineId: before.timeline.id,
    marker: { id: "marker-1", start: 1, duration: 0.5, name: "Review", startTime: { value: "24", timescale: "24" }, durationTime: { value: "12", timescale: "24" } },
  }, before.revision), /MARKER_ALREADY_EXISTS/);
  assert.deepEqual(calls, []);
});

test("marker accepts a distinct native identity and reordered marker list", async () => {
  const { before: original, after } = markerSnapshots();
  const existing = { id: "existing-marker", start: 3, duration: 0, name: "Existing", startTime: { value: "72", timescale: "24" }, durationTime: { value: "0", timescale: "24" } };
  original.timeline.markers.push(existing);
  after.timeline.markers[0] = { ...after.timeline.markers[0]!, id: "native-marker-id" };
  after.timeline.markers.push(existing);
  const calls: string[] = [];
  const provider = providerFor([original, original, after], calls, undefined, liveState(), undefined, {
    addMarkerAtTime: async () => { calls.push("marker"); return { operationId: "native-marker", undoAvailable: true }; },
  });
  const before = await provider.readProject();
  await provider.apply({
    type: "add-marker", timelineId: before.timeline.id,
    marker: { id: "requested-marker-id", start: 1, duration: 0.5, name: "Review", startTime: { value: "24", timescale: "24" }, durationTime: { value: "12", timescale: "24" } },
  }, before.revision);
  assert.deepEqual(calls, ["marker"]);
});

test("marker rejects collateral clip changes and restores the baseline", async () => {
  const { before: original, after } = markerSnapshots();
  const collateral = structuredClone(after);
  collateral.timeline.clips[0] = { ...collateral.timeline.clips[0]!, name: "Unexpected" };
  const calls: string[] = [];
  const provider = providerFor([original, original, collateral, original, original], calls, undefined, liveState(), undefined, {
    addMarkerAtTime: async () => { calls.push("marker"); return { operationId: "native-marker", undoAvailable: true }; },
  });
  const before = await provider.readProject();
  const operation = {
    type: "add-marker" as const, timelineId: before.timeline.id,
    marker: { id: "marker-1", start: 1, duration: 0.5, name: "Review", startTime: { value: "24", timescale: "24" }, durationTime: { value: "12", timescale: "24" } },
  };
  await assert.rejects(provider.apply(operation, before.revision), /FINAL_CUT_CANONICAL_READBACK_FAILED/);
  assert.deepEqual(calls, ["marker", "undo"]);
  assert.equal(canonicalSnapshotDigest(await provider.readProject()), canonicalSnapshotDigest(before));
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

test("gain readback accepts equivalent rational frame and source times", async () => {
  const { before: original, after } = gainSnapshots();
  original.timeline.clips[0] = { ...original.timeline.clips[0]!, sourceStart: 1, sourceStartTime: { value: "24", timescale: "24" } };
  after.timeline.clips[0] = { ...after.timeline.clips[0]!, sourceStart: 1, sourceStartTime: { value: "1", timescale: "1" } };
  after.timeline.frameDuration = { value: "2", timescale: "48" };
  const calls: string[] = [];
  const provider = providerFor([original, original, after], calls, undefined, liveState(), undefined, {
    setSelectedClipGain: async () => { calls.push("gain"); return { operationId: "native-gain", undoAvailable: true }; },
  });
  const before = await provider.readProject();
  await provider.apply({ type: "set-gain", clipId: before.timeline.clips[0]!.id, gainDb: 3 }, before.revision);
  assert.deepEqual(calls, ["gain"]);
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

test("verification read failure restores trim, marker, ripple, and gain", async () => {
  const cases = [
    { label: "trim", before: snapshot("Original"), operation: { type: "trim-clip" as const, clipId: "final-cut:occurrence:clip-1", duration: 3, durationTime: { value: "72", timescale: "24" } } },
    { label: "marker", before: markerSnapshots().before, operation: { type: "add-marker" as const, timelineId: "final-cut:sequence:sequence-1", marker: { id: "marker-1", start: 1, duration: 0.5, name: "Review", startTime: { value: "24", timescale: "24" }, durationTime: { value: "12", timescale: "24" } } } },
    { label: "ripple", before: rippleSnapshots().before, operation: { type: "ripple-delete" as const, timelineId: "final-cut:sequence:sequence-1", range: { start: 2, end: 4, startTime: { value: "48", timescale: "24" }, durationTime: { value: "48", timescale: "24" } }, candidateId: "filler-1", reason: "remove verified filler" } },
    { label: "gain", before: gainSnapshots().before, operation: { type: "set-gain" as const, clipId: "final-cut:occurrence:clip-1", gainDb: 3 } },
  ];
  for (const { label, before: original, operation } of cases) {
    const calls: string[] = [];
    const mutate = async () => { calls.push(label); return { operationId: `native-${label}`, undoAvailable: true }; };
    const provider = providerFor([original, original, new Error("controlled read failure"), original, original], calls, undefined, liveState(), undefined, {
      trimSelectedClipToRange: mutate, addMarkerAtTime: mutate, rippleDeleteRange: mutate, setSelectedClipGain: mutate,
    });
    const before = await provider.readProject();
    await assert.rejects(provider.apply(operation, before.revision), /controlled read failure/, label);
    assert.deepEqual(calls, [label, "undo"], label);
    assert.equal(canonicalSnapshotDigest(await provider.readProject()), canonicalSnapshotDigest(before), label);
  }
});

test("failed verification recovery blocks subsequent canonical edits", async () => {
  const original = snapshot("Original");
  const calls: string[] = [];
  const provider = providerFor(
    [original, original, new Error("controlled read failure"), original, original, original],
    calls, undefined, liveState(), undefined,
    { undo: async () => { calls.push("undo"); return { undone: false, verification: { verified: false } }; } },
  );
  const before = await provider.readProject();
  const operation = { type: "rename-clip" as const, clipId: "final-cut:occurrence:clip-1", name: "Renamed" };
  await assert.rejects(provider.apply(operation, before.revision), /FINAL_CUT_CANONICAL_ROLLBACK_FAILED:.*FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  const observed = await provider.readProject();
  await assert.rejects(provider.apply(operation, observed.revision), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  await assert.rejects(provider.previewTransaction([operation], observed.revision), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  assert.deepEqual(calls, ["edit", "undo"]);
});

test("missing native Undo blocks a second edit after mutation", async () => {
  const original = snapshot("Original");
  const calls: string[] = [];
  const provider = providerFor([original, original, original], calls, undefined, liveState(), undefined, {
    renameSelectedClip: async () => { calls.push("edit"); return { operationId: "native-without-undo", undoAvailable: false }; },
  });
  const before = await provider.readProject();
  const operation = { type: "rename-clip" as const, clipId: "final-cut:occurrence:clip-1", name: "Renamed" };
  await assert.rejects(provider.apply(operation, before.revision), /FINAL_CUT_CANONICAL_UNDO_UNAVAILABLE:.*FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  await assert.rejects(provider.apply(operation, before.revision), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  assert.deepEqual(calls, ["edit"]);
});

test("uncertain native edit failure blocks another mutation", async () => {
  const original = snapshot("Original");
  const calls: string[] = [];
  const provider = providerFor([original, original, original], calls, undefined, liveState(), undefined, {
    renameSelectedClip: async () => { calls.push("edit"); throw new Error("native dispatch failed after possible mutation"); },
  });
  const before = await provider.readProject();
  const operation = { type: "rename-clip" as const, clipId: "final-cut:occurrence:clip-1", name: "Renamed" };
  await assert.rejects(provider.apply(operation, before.revision), /native dispatch failed after possible mutation/);
  await assert.rejects(provider.apply(operation, before.revision), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  assert.deepEqual(calls, ["edit"]);
});

test("recovery checkpoint inspection reports the bound evidence and rejects corrupt records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-checkpoint-inspection-"));
  try {
    const path = join(directory, "checkpoint.json");
    const owner = new FileCanonicalRecoveryGuard(path);
    const observer = new FileCanonicalRecoveryGuard(path);
    assert.equal(await observer.inspect(), undefined);
    const checkpoint = { projectId: "project-1", sequenceId: "sequence-1", baseRevision: "rev-1", beforeDigest: "a".repeat(64), operation: "undo", expectedRestoreDigest: "b".repeat(64) };
    await owner.begin(checkpoint);
    assert.deepEqual(await observer.inspect(), checkpoint);
    const record = JSON.parse(await readFile(path, "utf8"));
    for (const corrupt of [
      { ...checkpoint, beforeDigest: "invalid" },
      { ...checkpoint, expectedRestoreDigest: "invalid" },
    ]) {
      await writeFile(path, JSON.stringify({ ...record, checkpoint: corrupt }));
      await assert.rejects(observer.inspect(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
      await assert.rejects(observer.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    }
    await rm(path);
    const target = join(directory, "other.json");
    await writeFile(target, "{}");
    await symlink(target, path);
    await assert.rejects(observer.inspect(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    await assert.rejects(observer.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checkpoint evidence distinguishes replacement with identical target data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-checkpoint-version-"));
  try {
    const path = join(directory, "pending.json");
    const first = new FileCanonicalRecoveryGuard(path);
    const second = new FileCanonicalRecoveryGuard(path);
    const checkpoint = { projectId: "project-1", sequenceId: "sequence-1", baseRevision: "rev-1", beforeDigest: "a".repeat(64), operation: "rename-clip" };
    await first.begin(checkpoint);
    const initial = await first.inspectVersioned();
    assert.deepEqual(initial?.checkpoint, checkpoint);
    await first.complete();
    await second.begin(checkpoint);
    const replaced = await second.inspectVersioned();
    assert.deepEqual(replaced?.checkpoint, checkpoint);
    assert.notEqual(replaced?.checkpointId, initial?.checkpointId);
    await second.complete();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable canonical recovery checkpoint blocks other instances until its owner completes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-canonical-recovery-"));
  try {
    const path = join(directory, "recovery", "checkpoint.json");
    const owner = new FileCanonicalRecoveryGuard(path);
    const restarted = new FileCanonicalRecoveryGuard(path);
    await owner.assertClear();
    const checkpoint = { projectId: "project-1", sequenceId: "sequence-1", baseRevision: "rev-1", beforeDigest: "digest-1", operation: "rename-clip" };
    await owner.begin(checkpoint);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).checkpoint, checkpoint);
    await assert.rejects(restarted.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    await assert.rejects(restarted.begin(checkpoint), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    await assert.rejects(restarted.complete(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    await owner.complete();
    await restarted.assertClear();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live revision drift during checkpoint acquisition prevents native mutation", async () => {
  const original = snapshot("Original");
  const active = liveState();
  const calls: string[] = [];
  const guard = {
    assertClear: async () => {},
    begin: async () => { assert.ok(active.revision); active.revision.id = "revision-after-checkpoint"; },
    complete: async () => { calls.push("checkpoint-cleared"); },
  };
  const provider = providerFor([original, original], calls, undefined, active, undefined, {}, guard);
  const before = await provider.readProject();
  await assert.rejects(provider.apply({ type: "rename-clip", clipId: "final-cut:occurrence:clip-1", name: "Renamed" }, before.revision), /FINAL_CUT_CANONICAL_TARGET_STALE/);
  assert.deepEqual(calls, ["checkpoint-cleared"]);
});

test("target drift during Undo checkpoint acquisition prevents native Undo", async () => {
  const original = snapshot("Original");
  const renamed = snapshot("Renamed");
  const active = liveState();
  const calls: string[] = [];
  let acquisitions = 0;
  const guard = {
    assertClear: async () => {},
    begin: async () => { if (++acquisitions === 2) { assert.ok(active.sequence); active.sequence.id = "other-sequence"; } },
    complete: async () => { calls.push("checkpoint-cleared"); },
  };
  const provider = providerFor([original, original, renamed, renamed], calls, undefined, active, undefined, {}, guard);
  const before = await provider.readProject();
  const revision = await provider.apply({ type: "rename-clip", clipId: "final-cut:occurrence:clip-1", name: "Renamed" }, before.revision);
  await assert.rejects(provider.restore(before, revision), /FINAL_CUT_CANONICAL_TARGET_STALE/);
  assert.deepEqual(calls, ["edit", "checkpoint-cleared", "checkpoint-cleared"]);
});

test("Undo checkpoint retains the intended restoration digest", async () => {
  const original = snapshot("Original");
  const renamed = snapshot("Renamed");
  const calls: string[] = [];
  const checkpoints: Array<{ beforeDigest: string; operation: string; expectedRestoreDigest?: string }> = [];
  const guard = {
    assertClear: async () => {},
    begin: async (checkpoint: { beforeDigest: string; operation: string; expectedRestoreDigest?: string }) => { checkpoints.push(checkpoint); },
    complete: async () => {},
  };
  const provider = providerFor([original, original, renamed, renamed, original], calls, undefined, liveState(), undefined, {}, guard);
  const before = await provider.readProject();
  const revision = await provider.apply({ type: "rename-clip", clipId: "final-cut:occurrence:clip-1", name: "Renamed" }, before.revision);
  await provider.restore(before, revision);
  assert.equal(checkpoints[1]?.operation, "undo");
  assert.equal(checkpoints[1]?.beforeDigest, canonicalSnapshotDigest(renamed));
  assert.equal(checkpoints[1]?.expectedRestoreDigest, canonicalSnapshotDigest(before));
});

test("verified canonical edit clears its checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-recovery-success-"));
  try {
    const path = join(directory, "checkpoint.json");
    const original = snapshot("Original");
    const calls: string[] = [];
    const provider = providerFor([original, original, snapshot("Renamed")], calls, undefined, liveState(), undefined, {}, new FileCanonicalRecoveryGuard(path));
    const before = await provider.readProject();
    await provider.apply({ type: "rename-clip", clipId: "final-cut:occurrence:clip-1", name: "Renamed" }, before.revision);
    assert.deepEqual(calls, ["edit"]);
    await new FileCanonicalRecoveryGuard(path).assertClear();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checkpoint creation failure prevents native mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-recovery-unavailable-"));
  try {
    const parent = join(directory, "not-a-directory");
    await writeFile(parent, "file");
    const original = snapshot("Original");
    const calls: string[] = [];
    const provider = providerFor([original, original], calls, undefined, liveState(), undefined, {}, new FileCanonicalRecoveryGuard(join(parent, "checkpoint.json")));
    const before = await provider.readProject();
    await assert.rejects(provider.apply({ type: "rename-clip", clipId: "final-cut:occurrence:clip-1", name: "Renamed" }, before.revision));
    assert.deepEqual(calls, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("verified recovery clears the durable checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-recovery-verified-"));
  try {
    const path = join(directory, "checkpoint.json");
    const original = snapshot("Original");
    const calls: string[] = [];
    const provider = providerFor([original, original, new Error("readback failed"), original], calls, undefined, liveState(), undefined, {}, new FileCanonicalRecoveryGuard(path));
    const before = await provider.readProject();
    await assert.rejects(provider.apply({ type: "rename-clip", clipId: "final-cut:occurrence:clip-1", name: "Renamed" }, before.revision), /readback failed/);
    assert.deepEqual(calls, ["edit", "undo"]);
    await new FileCanonicalRecoveryGuard(path).assertClear();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uncertain edit remains blocked after provider restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-recovery-restart-"));
  try {
    const path = join(directory, "checkpoint.json");
    const original = snapshot("Original");
    const calls: string[] = [];
    const failed = providerFor([original, original], calls, undefined, liveState(), undefined, {
      renameSelectedClip: async () => { calls.push("edit"); throw new Error("uncertain dispatch"); },
    }, new FileCanonicalRecoveryGuard(path));
    const before = await failed.readProject();
    const operation = { type: "rename-clip" as const, clipId: "final-cut:occurrence:clip-1", name: "Renamed" };
    await assert.rejects(failed.apply(operation, before.revision), /uncertain dispatch/);
    const restarted = providerFor([original, original, original], calls, undefined, liveState(), undefined, {}, new FileCanonicalRecoveryGuard(path));
    const rebound = await restarted.readProject();
    await assert.rejects(restarted.apply(operation, rebound.revision), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    assert.deepEqual(calls, ["edit"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("automatic recovery does not Undo a different live target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-recovery-target-"));
  try {
    const path = join(directory, "checkpoint.json");
    const original = snapshot("Original");
    const active = liveState();
    const calls: string[] = [];
    const provider = providerFor([original, original], calls, undefined, active, undefined, {
      renameSelectedClip: async () => {
        calls.push("edit");
        assert.ok(active.sequence);
        active.sequence.id = "different-sequence";
        return { operationId: "native-edit", undoAvailable: true };
      },
    }, new FileCanonicalRecoveryGuard(path));
    const before = await provider.readProject();
    await assert.rejects(provider.apply({ type: "rename-clip", clipId: "final-cut:occurrence:clip-1", name: "Renamed" }, before.revision), /FINAL_CUT_CANONICAL_ROLLBACK_FAILED/);
    assert.deepEqual(calls, ["edit"]);
    await assert.rejects(new FileCanonicalRecoveryGuard(path).assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unverified explicit Undo blocks subsequent canonical edits", async () => {
  const original = snapshot("Original");
  const renamed = snapshot("Renamed");
  const calls: string[] = [];
  const provider = providerFor([original, original, renamed, renamed, renamed, renamed], calls, undefined, liveState(), undefined, {
    undo: async () => { calls.push("undo"); return { undone: false, verification: { verified: false } }; },
  });
  const before = await provider.readProject();
  const operation = { type: "rename-clip" as const, clipId: "final-cut:occurrence:clip-1", name: "Renamed" };
  const revision = await provider.apply(operation, before.revision);
  await assert.rejects(provider.restore(before, revision), /FINAL_CUT_CANONICAL_UNDO_FAILED:.*FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  await assert.rejects(provider.apply(operation, revision), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  assert.deepEqual(calls, ["edit", "undo"]);
});

test("rename rejects collateral changes to the same clip and restores the baseline", async () => {
  const original = snapshot("Original");
  const collateral = snapshot("Renamed");
  collateral.timeline.clips[0] = { ...collateral.timeline.clips[0]!, gainDb: 3 };
  const calls: string[] = [];
  const provider = providerFor([original, original, collateral, original, original], calls);
  const before = await provider.readProject();
  await assert.rejects(provider.apply({ type: "rename-clip", clipId: before.timeline.clips[0]!.id, name: "Renamed" }, before.revision), /FINAL_CUT_CANONICAL_READBACK_FAILED/);
  assert.deepEqual(calls, ["edit", "undo"]);
  assert.equal(canonicalSnapshotDigest(await provider.readProject()), canonicalSnapshotDigest(before));
});

test("canonical native provider rejects collateral changes in rename readback", async () => {
  const calls: string[] = [];
  const after = snapshot("Renamed");
  after.timeline.markers.push({ id: "collateral-marker", start: 1, duration: 0, name: "Unexpected" });
  const provider = providerFor([
    snapshot("Original"),
    snapshot("Original"),
    after,
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
    /renamed occurrence was not read back as a rename-only diff/,
  );
  assert.deepEqual(calls, ["edit", "undo"]);
});

test("canonical native provider rejects ambiguous occurrence bindings before edit", async () => {
  const calls: string[] = [];
  const resolveTarget: CanonicalNativeTargetResolver = Object.assign(async () => {
    throw new Error("AMBIGUOUS_PROJECT_TARGET: occurrence binding is not unique");
  }, { sourceBindingAvailable: true });
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
  assert.match(script, /perform action "AXRaise" of window "Final Cut Pro" of finalCut/);
  assert.match(script, /on findTimelineArea\(container, depth\)/);
  assert.match(script, /set timelineArea to my findTimelineArea\(frontWindow, 0\)/);
  assert.match(script, /perform action "AXPress" of timelineArea/);
  assert.doesNotMatch(script, /FRAMEKIT_FCPXML_PATH/);
});

test("canonical Final Cut export overrides a remembered save folder for Desktop targets", () => {
  const exportPath = join(homedir(), "Desktop", "framekit-canonical.fcpxml");
  const script = buildFinalCutCanonicalExportScript(exportPath);

  assert.match(script, /keystroke "g" using \{command down, shift down\}/);
  assert.match(script, new RegExp(`set value of pathField to "${join(homedir(), "Desktop")}"`));
});

test("canonical Final Cut export discovers nested save controls", () => {
  const script = buildFinalCutCanonicalExportScript("/tmp/framekit-canonical.fcpxml");

  assert.match(script, /on findAccessibilityDescendant\(container, expectedRoles, depth\)/);
  assert.match(script, /UI elements of container/);
  assert.match(script, /if depth > 12 then return missing value/);
  assert.match(script, /on accessibilityMatchesExpectedName\(candidate, expectedNames\)/);
  assert.match(script, /\{"AXDescription", "AXTitle", "AXIdentifier"\}/);
  assert.match(script, /\{"AXTextField", "AXTextArea", "AXComboBox"\}/);
  assert.match(script, /on matchesCanonicalPathField\(candidate\)/);
  assert.match(script, /Go to the folder/);
  assert.match(script, /on findFocusedCanonicalPathField\(container, focusedCandidate, depth, insidePathContainer\)/);
  assert.match(script, /candidateInsidePathContainer then/);
  assert.match(script, /if container is focusedCandidate then return container/);
  assert.match(script, /if my matchesCanonicalPathField\(focusedCandidate\) then return focusedCandidate/);
  assert.match(script, /keystroke "a" using \{command down\}[\s\S]*?keystroke "\/tmp"[\s\S]*?key code 36/);
  assert.match(script, /text field 1 of sheet 1 of window "Export XML"/);
  assert.match(script, /on findSavePathField\(saveWindow, timeoutSeconds, timeoutMessage\)/);
  assert.doesNotMatch(script, /set pathField to my findSavePathField/);
  assert.match(script, /on findCanonicalSaveNameField\(saveWindow, timeoutSeconds, timeoutMessage\)/);
  assert.match(script, /id of candidate/);
  assert.match(script, /PathTextField/);
  assert.match(script, /saveAsNameTextField/);
  assert.match(script, /set value of nameField to "framekit-canonical\.fcpxml"/);
  assert.doesNotMatch(script, /findAccessibilityDescendant\(saveWindow, pathFieldRoles/);
  assert.match(script, /on findAccessibilityIdentifier\(container, expectedIdentifier, depth\)/);
  assert.match(script, /if depth > 12 then return missing value/);
  assert.match(script, /my pressAccessibilityButtonIfPresent\(saveWindow, \{"Save"\}\)/);
  assert.doesNotMatch(script, /repeat 10 times[\s\S]*pressAccessibilityButtonIfPresent\(saveWindow, \{"Save"\}\)/);
  assert.doesNotMatch(script, /pressAccessibilityButtonIfPresent\(saveWindow, \{"Replace"\}\)/);
  assert.match(script, /set saveRoot to first UI element of saveWindow/);
  assert.match(script, /set value of nameField/);
  assert.match(script, /set nameField to text field 2 of saveRoot/);
  assert.match(script, /perform action "AXPress" of button 3 of saveRoot/);
  assert.doesNotMatch(script, /perform action "AXPress" of button 2 of sheet 1 of saveWindow/);
  assert.doesNotMatch(script, /entire contents of saveContainer/);
  assert.doesNotMatch(script, /my findDescendantByRole\(saveWindow, "AXSheet"/);
  assert.doesNotMatch(script, /my findDescendantByRole\(pathSheet, "AXTextField"/);
  assert.doesNotMatch(script, /entire contents of container/);
});

test("canonical export parses a structured retryable recovery result", () => {
  const result = parseFinalCutCanonicalExportResult(JSON.stringify({
    status: "retryable",
    code: "FINAL_CUT_CANONICAL_SAVE_WINDOW_UNAVAILABLE",
    message: "Final Cut export dialogs were closed; retry the canonical read",
    cleanup: "complete",
  }));

  assert.deepEqual(result, {
    status: "retryable",
    code: "FINAL_CUT_CANONICAL_SAVE_WINDOW_UNAVAILABLE",
    message: "Final Cut export dialogs were closed; retry the canonical read",
    cleanup: "complete",
  });

  const error = new FinalCutCanonicalExportError(result);
  assert.equal(error.code, "FINAL_CUT_CANONICAL_SAVE_WINDOW_UNAVAILABLE");
  assert.equal(error.retryable, true);
  assert.equal(error.cleanup, "complete");
});

test("canonical export surfaces retryable recovery results", async () => {
  const source = new FinalCutCanonicalSnapshotSource({
    executor: async () => JSON.stringify({
      status: "retryable",
      code: "FINAL_CUT_CANONICAL_SAVE_WINDOW_UNAVAILABLE",
      message: "Final Cut export dialogs were closed; retry the canonical read",
      cleanup: "complete",
    }),
  });

  await assert.rejects(source.readSnapshot(), (error: unknown) => {
    assert.ok(error instanceof FinalCutCanonicalExportError);
    assert.equal(error.retryable, true);
    assert.equal(error.cleanup, "complete");
    return true;
  });
});

test("canonical export retries a cleaned-up recovery result", async () => {
  const completeDocument = "<?xml version=\"1.0\"?><fcpxml><resources/><library><event><project uid=\"project-retry\" name=\"Retry\"><sequence uid=\"sequence-retry\" name=\"Main\" duration=\"1s\"><spine/></sequence></project></event></library></fcpxml>";
  let attempts = 0;
  const source = new FinalCutCanonicalSnapshotSource({
    exportTimeoutMs: 500,
    pollIntervalMs: 10,
    executor: async (script) => {
      attempts += 1;
      if (attempts === 1) {
        return JSON.stringify({
          status: "retryable",
          code: "FINAL_CUT_CANONICAL_EXPORT_WINDOW_UNAVAILABLE",
          message: "Final Cut export dialogs were closed; retry the canonical read",
          cleanup: "complete",
        });
      }
      const directoryMatch = script.match(/set value of pathField to "([^"]+)"/);
      const nameMatch = script.match(/set value of nameField to "([^"]+)"/);
      assert.ok(directoryMatch?.[1]);
      assert.ok(nameMatch?.[1]);
      await writeFile(join(directoryMatch[1], nameMatch[1]), completeDocument);
      return JSON.stringify({ status: "export-requested", code: "", message: "", cleanup: "complete" });
    },
  });

  const project = await source.readSnapshot();
  assert.equal(project.projectName, "Retry");
  assert.equal(attempts, 2);
});

test("canonical export recovers generated dialogs on UI failure", () => {
  const script = buildFinalCutCanonicalExportScript("/tmp/framekit-canonical.fcpxml");

  assert.match(script, /on findSavePathField\(saveWindow, timeoutSeconds, timeoutMessage\)/);
  assert.match(script, /on cleanupCanonicalExport\(finalCut\)/);
  assert.match(script, /on error errorMessage number errorNumber/);
  assert.match(script, /my cleanupCanonicalExport\(finalCut\)/);
  assert.match(script, /my canonicalExportResponse\("retryable"/);
  assert.match(script, /perform action "AXPress" of candidate/);
  assert.match(script, /click candidate/);
  assert.equal((script.match(/set saveWindow to my findWindow/g) ?? []).length, 1);
  assert.match(script, /set value of nameField/);
  assert.match(script, /set nameField to text field 2 of saveRoot/);
  assert.match(script, /perform action "AXPress" of button 3 of saveRoot/);
  assert.match(script, /my pressAccessibilityButtonIfPresent\(saveWindow, \{"Save"\}\)/);
  assert.doesNotMatch(script, /my findDescendantByRole\(saveWindow, "AXSheet"/);
});

test("canonical Final Cut export waits for a complete FCPXML file", async () => {
  const completeDocument = "<?xml version=\"1.0\"?><fcpxml><resources/><library><event><project uid=\"project-export\" name=\"Exported\"><sequence uid=\"sequence-export\" name=\"Main\" duration=\"1s\"><spine/></sequence></project></event></library></fcpxml>";
  let finishExport: Promise<void> | undefined;
  const source = new FinalCutCanonicalSnapshotSource({
    exportTimeoutMs: 500,
    pollIntervalMs: 10,
    executor: async (script) => {
      assert.match(script, /my canonicalExportResponse\("export-requested"/);
      const exportPath = canonicalExportPath(script);
      const partialDocument = completeDocument.slice(0, Math.floor(completeDocument.length / 2));
      await writeFile(exportPath, partialDocument);
      finishExport = new Promise((resolve) => {
        setTimeout(() => {
          void appendFile(exportPath, completeDocument.slice(partialDocument.length))
            .catch(() => undefined)
            .finally(resolve);
        }, 40);
      });
      return JSON.stringify({
        status: "export-requested",
        code: "",
        message: "",
        cleanup: "complete",
      });
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

test("canonical Final Cut export reads the native directory package", async () => {
  const completeDocument = "<?xml version=\"1.0\"?><fcpxml><resources/><library><event><project uid=\"project-package\" name=\"Packaged\"><sequence uid=\"sequence-package\" name=\"Main\" duration=\"1s\"><spine/></sequence></project></event></library></fcpxml>";
  const source = new FinalCutCanonicalSnapshotSource({
    exportTimeoutMs: 500,
    pollIntervalMs: 10,
    executor: async (script) => {
      const packagePath = `${canonicalExportPath(script)}.fcpxmld`;
      await mkdir(packagePath);
      await writeFile(join(packagePath, "Info.fcpxml"), completeDocument);
      return JSON.stringify({ status: "export-requested", code: "", message: "", cleanup: "complete" });
    },
  });

  const project = await source.readSnapshot();
  assert.equal(project.projectName, "Packaged");
});

test("canonical export binds missing sequence UID to the live target", async () => {
  const completeDocument = "<?xml version=\"1.0\"?><fcpxml><resources/><library><event><project uid=\"project-package\" name=\"Packaged\"><sequence name=\"Main\" duration=\"1s\"><spine/></sequence></project></event></library></fcpxml>";
  const source = new FinalCutCanonicalSnapshotSource({
    target: {
      projectId: "project-live",
      projectUid: "project-package",
      sequenceId: "sequence-live",
    },
    exportTimeoutMs: 500,
    pollIntervalMs: 10,
    executor: async (script) => {
      const packagePath = `${canonicalExportPath(script)}.fcpxmld`;
      await mkdir(packagePath);
      await writeFile(join(packagePath, "Info.fcpxml"), completeDocument);
      return JSON.stringify({ status: "export-requested", code: "", message: "", cleanup: "complete" });
    },
  });

  const project = await source.readSnapshot();
  assert.equal(project.projectId, "project-live");
  assert.equal(project.timeline.id, "sequence-live");
});

test("publish canonical readback binds a catalog target when the export has no immutable UIDs", async () => {
  const source = new FinalCutCanonicalSnapshotSource({
    readbackTarget: {
      projectId: "catalog-project",
      sequenceId: "catalog-sequence",
      projectName: "Created Edit",
      sequenceName: "Main",
    },
    exportTimeoutMs: 500,
    pollIntervalMs: 10,
    executor: async (script) => {
      await writeFile(canonicalExportPath(script), '<fcpxml version="1.11"><library><event><project name="Created Edit"><sequence name="Main" duration="1s"><spine/></sequence></project></event></library></fcpxml>');
      return JSON.stringify({ status: "export-requested", code: "", message: "", cleanup: "complete" });
    },
  });

  const snapshot = await source.readSnapshot();
  assert.equal(snapshot.projectId, "catalog-project");
  assert.equal(snapshot.timeline.id, "catalog-sequence");
});

test("publish canonical readback rejects an export for another named target", async () => {
  const source = new FinalCutCanonicalSnapshotSource({
    readbackTarget: {
      projectId: "catalog-project",
      sequenceId: "catalog-sequence",
      projectName: "Created Edit",
      sequenceName: "Main",
    },
    exportTimeoutMs: 500,
    pollIntervalMs: 10,
    executor: async (script) => {
      await writeFile(canonicalExportPath(script), '<fcpxml version="1.11"><library><event><project name="Another Edit"><sequence name="Main" duration="1s"><spine/></sequence></project></event></library></fcpxml>');
      return JSON.stringify({ status: "export-requested", code: "", message: "", cleanup: "complete" });
    },
  });

  await assert.rejects(source.readSnapshot(), /TARGET_MISMATCH: canonical export project and sequence names/);
});

test("canonical export rejects a sequence UID from another live target", async () => {
  const completeDocument = "<?xml version=\"1.0\"?><fcpxml><resources/><library><event><project uid=\"project-package\" name=\"Packaged\"><sequence uid=\"sequence-other\" name=\"Main\" duration=\"1s\"><spine/></sequence></project></event></library></fcpxml>";
  const source = new FinalCutCanonicalSnapshotSource({
    target: {
      projectId: "project-live",
      projectUid: "project-package",
      sequenceId: "sequence-live",
    },
    exportTimeoutMs: 500,
    pollIntervalMs: 10,
    executor: async (script) => {
      const packagePath = `${canonicalExportPath(script)}.fcpxmld`;
      await mkdir(packagePath);
      await writeFile(join(packagePath, "Info.fcpxml"), completeDocument);
      return JSON.stringify({ status: "export-requested", code: "", message: "", cleanup: "complete" });
    },
  });

  await assert.rejects(source.readSnapshot(), /TARGET_MISMATCH: exported sequence UID/);
});

test("canonical export rejects a live target from another project", async () => {
  const completeDocument = "<?xml version=\"1.0\"?><fcpxml><resources/><library><event><project uid=\"project-package\" name=\"Packaged\"><sequence name=\"Main\" duration=\"1s\"><spine/></sequence></project></event></library></fcpxml>";
  const source = new FinalCutCanonicalSnapshotSource({
    target: {
      projectId: "project-live",
      projectUid: "project-other",
      sequenceId: "sequence-live",
    },
    exportTimeoutMs: 500,
    pollIntervalMs: 10,
    executor: async (script) => {
      const packagePath = `${canonicalExportPath(script)}.fcpxmld`;
      await mkdir(packagePath);
      await writeFile(join(packagePath, "Info.fcpxml"), completeDocument);
      return JSON.stringify({ status: "export-requested", code: "", message: "", cleanup: "complete" });
    },
  });

  await assert.rejects(source.readSnapshot(), /TARGET_MISMATCH/);
});

test("canonical target resolver requires one exact native occurrence", async () => {
  const native = {
    searchMedia: async () => [{
      handle: "media-handle",
      name: "clip.mov",
      sourceIdentity: "browser-source-1",
      source: "/tmp/clip.mov",
    }],
    selectOccurrence: async () => ({ target: { kind: "selected-clip", identity: "native-occurrence-1" } }) as never,
    locateOccurrence: async () => ({
      status: "unique" as const,
      occurrences: [{
        handle: "occurrence-handle",
        mediaHandle: "media-handle",
        name: "Original",
        identity: "native-occurrence-1",
        sourceIdentity: "browser-source-1",
        start: "0/24",
        duration: "96/24",
        sequenceId: "final-cut:sequence:sequence-1",
      }],
    }),
  };

  const resolver = createFinalCutNativeTargetResolver(native);
  await resolver(snapshot("Original").timeline.clips[0]!, snapshot("Original"));
});

test("canonical target resolver searches literal source basenames outside the public wildcard contract", async () => {
  const project = snapshot("Original");
  project.media[0]!.source = "/tmp/interview?.mov";
  const seenQueries: string[] = [];
  const native = {
    searchMedia: async () => {
      throw new Error("FINAL_CUT_NATIVE_SEARCH_WILDCARD_UNSUPPORTED: wildcard input is rejected");
    },
    searchMediaForCanonicalTarget: async (query: string) => {
      seenQueries.push(query);
      return [{ handle: "media-handle", name: query, sourceIdentity: "browser-source-1", source: "/tmp/interview?.mov" }];
    },
    selectOccurrence: async () => ({ target: { kind: "selected-clip", identity: "native-occurrence-1" } }) as never,
    locateOccurrence: async () => ({
      status: "unique" as const,
      occurrences: [{
        handle: "occurrence-handle",
        mediaHandle: "media-handle",
        name: "Original",
        identity: "native-occurrence-1",
        sourceIdentity: "browser-source-1",
        start: "0/24",
        duration: "96/24",
        sequenceId: "final-cut:sequence:sequence-1",
      }],
    }),
  };

  const resolver = createFinalCutNativeTargetResolver(native);
  await resolver(project.timeline.clips[0]!, project);
  assert.deepEqual(seenQueries, ["interview?.mov"]);
});

test("canonical target resolver selects the coordinate-matching occurrence from duplicate media", async () => {
  const selected: string[] = [];
  const native = {
    searchMedia: async () => [{
      handle: "media-handle",
      name: "clip.mov",
      sourceIdentity: "browser-source-1",
      source: "/tmp/clip.mov",
    }],
    locateOccurrence: async () => ({
      status: "ambiguous" as const,
      occurrences: [
        {
          handle: "occurrence-first",
          mediaHandle: "media-handle",
          name: "Original",
          start: "0/24",
          duration: "96/24",
          sequenceId: "final-cut:sequence:sequence-1",
        },
        {
          handle: "occurrence-target",
          mediaHandle: "media-handle",
          name: "Original",
          identity: "native-target",
          sourceIdentity: "browser-source-1",
          start: "96/24",
          duration: "96/24",
          sequenceId: "final-cut:sequence:sequence-1",
        },
      ],
    }),
    selectOccurrence: async (handle: string) => {
      selected.push(handle);
      return { target: { kind: "selected-clip", identity: "native-target" } } as never;
    },
  };
  const targetSnapshot = structuredClone(snapshot("Original"));
  targetSnapshot.timeline.clips[0] = {
    ...targetSnapshot.timeline.clips[0]!,
    start: 4,
    startTime: { value: "96", timescale: "24" },
  };

  const resolver = createFinalCutNativeTargetResolver(native);
  await resolver(targetSnapshot.timeline.clips[0]!, targetSnapshot);
  assert.deepEqual(selected, ["occurrence-target"]);
});

test("canonical target resolver rejects ambiguous native media", async () => {
  const native = {
    searchMedia: async () => [
      { handle: "media-1", name: "clip.mov", sourceIdentity: "browser-source-1", source: "/tmp/clip.mov" },
      { handle: "media-2", name: "clip.mov", sourceIdentity: "browser-source-2", source: "/tmp/clip.mov" },
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
      source: "/tmp/clip.mov",
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
      source: "/tmp/clip.mov",
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

test("canonical native edit rejects live revision drift during target resolution", async () => {
  let current = liveState();
  let mutations = 0;
  const provider = new FinalCutCanonicalNativeProvider({
    live: {
      getIdentity: async () => identity,
      readLiveState: async () => structuredClone(current),
      liveChangesSince: async () => [],
    },
    native: {
      renameSelectedClip: async () => { mutations++; return { operationId: "op", undoAvailable: true }; },
      undo: async () => ({ undone: true, verification: { verified: true } }),
    },
    readSnapshot: async () => snapshot("Original"),
    resolveTarget: Object.assign(async () => {
      current = { ...current, revision: { id: "externally-changed", sequence: 2, timestamp: new Date(2).toISOString() } };
    }, { sourceBindingAvailable: true }),
  });
  const before = await provider.readProject();
  await assert.rejects(provider.apply({ type: "rename-clip", clipId: before.timeline.clips[0]!.id, name: "New", baseRevision: before.revision }, before.revision), /STALE|TARGET_MISMATCH/);
  assert.equal(mutations, 0);
});

test("canonical native edit allows refreshed observation timestamps for the same live revision", async () => {
  let reads = 0;
  let edited = false;
  const provider = new FinalCutCanonicalNativeProvider({
    live: {
      getIdentity: async () => identity,
      readLiveState: async () => ({ ...liveState(), revision: { ...liveState().revision, timestamp: new Date(++reads * 1000).toISOString() } }),
      liveChangesSince: async () => [],
    },
    native: {
      renameSelectedClip: async () => { edited = true; return { operationId: "op", undoAvailable: true }; },
      undo: async () => ({ undone: true, verification: { verified: true } }),
    },
    readSnapshot: async () => snapshot(edited ? "New" : "Original"),
    resolveTarget: Object.assign(async () => {}, { sourceBindingAvailable: true }),
  });
  const before = await provider.readProject();
  await provider.apply({ type: "rename-clip", clipId: before.timeline.clips[0]!.id, name: "New", baseRevision: before.revision }, before.revision);
  assert.equal(edited, true);
});

test("canonical revision changes when live revision changes despite identical snapshot", async () => {
  let current = liveState();
  const provider = new FinalCutCanonicalNativeProvider({
    live: {
      getIdentity: async () => identity,
      readLiveState: async () => structuredClone(current),
      liveChangesSince: async () => [],
    },
    native: { renameSelectedClip: async () => ({ operationId: "op", undoAvailable: true }), undo: async () => ({ undone: true }) },
    readSnapshot: async () => snapshot("Original"),
    resolveTarget: async () => {},
  });
  const before = await provider.readProject();
  current = { ...current, revision: { ...current.revision, timestamp: new Date(2000).toISOString() } };
  const same = await provider.readProject();
  assert.equal(same.revision.sequence, before.revision.sequence);
  current = { ...current, revision: { id: "live-changed", sequence: 2, timestamp: new Date(3000).toISOString() } };
  const changed = await provider.readProject();
  assert.ok(changed.revision.sequence > before.revision.sequence);
  assert.notEqual(changed.revision.id, before.revision.id);
  await assert.rejects(provider.previewTransaction([{ type: "rename-clip", clipId: before.timeline.clips[0]!.id, name: "New", baseRevision: before.revision }], before.revision), /STALE_CONTEXT/);
});

test("canonical revisions from a prior provider instance cannot authorize edits", async () => {
  const first = providerFor([snapshot("Original")], []);
  const calls: string[] = [];
  const second = providerFor([snapshot("Original"), snapshot("Original")], calls);
  const before = await first.readProject();
  const restarted = await second.readProject();
  assert.notEqual(restarted.revision.id, before.revision.id);
  await assert.rejects(second.apply({ type: "rename-clip", clipId: before.timeline.clips[0]!.id, name: "New", baseRevision: before.revision }, before.revision), /STALE_CONTEXT/);
  assert.deepEqual(calls, []);
});

test("canonical reads reject live revision changes during snapshot export", async () => {
  let current = liveState();
  const provider = new FinalCutCanonicalNativeProvider({
    live: {
      getIdentity: async () => identity,
      readLiveState: async () => structuredClone(current),
      liveChangesSince: async () => [],
    },
    native: { renameSelectedClip: async () => ({ operationId: "op", undoAvailable: true }), undo: async () => ({ undone: true }) },
    readSnapshot: async () => {
      current = { ...current, revision: { id: "changed", sequence: 2, timestamp: new Date(2).toISOString() } };
      return snapshot("Original");
    },
    resolveTarget: async () => {},
  });
  await assert.rejects(provider.readProject(), /STALE|TARGET_MISMATCH/);
});

test("MCP editor inspection never probes a headed canonical snapshot", async () => {
  let snapshotReads = 0;
  let snapshotUnavailable = false;
  let currentLive = liveState();
  const provider = new FinalCutCanonicalNativeProvider({
    live: { ...liveWithoutBackgroundCatalog(), readLiveState: async () => structuredClone(currentLive) },
    native: { renameSelectedClip: async () => ({ operationId: "op", undoAvailable: true }), undo: async () => ({ undone: true }) },
    readSnapshot: async () => { snapshotReads++; if (snapshotUnavailable) throw new Error("snapshot unavailable"); return snapshot("Original"); },
    resolveTarget: async () => {},
    backgroundCatalog: { listProjects: async () => ({
      projects: [{ id: "final-cut:project:project-1", name: "Canonical E2E", sequences: [{ id: "final-cut:sequence:sequence-1", name: "Canonical E2E" }] }],
      activeProjectId: "final-cut:project:project-1", activeSequenceId: "final-cut:sequence:sequence-1",
    }) },
  });
  const runtime = new Runtime(new FinalCutSessionAdapter({ live: provider }));
  const server = createMcpServer(runtime, { processMode: "headed" });
  const client = new Client({ name: "passive-inspection", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const result = await client.callTool({ name: "editor.inspect", arguments: {} });
    assert.equal(result.isError, undefined);
    assert.equal(snapshotReads, 0, "passive inspection must not run a headed snapshot export");
    const inspected = JSON.parse(textFrom(result));
    assert.equal(inspected.capabilities.editor.timelineSnapshotRead, false);
    await client.callTool({ name: "editing.route", arguments: { operation: "project.select" } });
    assert.equal(snapshotReads, 0, "routing inspection must not run a headed snapshot export");
    const context = await client.callTool({ name: "context.inspect", arguments: {} });
    assert.equal(context.isError, undefined);
    const metadata = JSON.parse(textFrom(context));
    assert.equal(metadata.project, undefined);
    assert.equal(snapshotReads, 0, "context inspection must not run a headed snapshot export without authorization");
    await client.callTool({ name: "context.changes", arguments: { revision: metadata.revision } });
    assert.equal(snapshotReads, 0, "context changes must not run a headed snapshot export");
    await client.callTool({ name: "timeline.changes", arguments: {} });
    assert.equal(snapshotReads, 0, "timeline changes must not run a headed snapshot export");
    await runtime.inspectContext();
    await runtime.inspectContext({});
    assert.equal(snapshotReads, 0, "runtime context inspection must default to a passive capability check");
    const unconfirmedProject = await client.callTool({ name: "project.inspect", arguments: {} });
    assert.equal(unconfirmedProject.isError, true, "headed project reads require explicit confirmation and target IDs");
    assert.equal(snapshotReads, 0, "unconfirmed project inspection must not export a headed snapshot");
    const unconfirmedTimeline = await client.callTool({ name: "timeline.inspect", arguments: {} });
    assert.equal(unconfirmedTimeline.isError, true, "headed timeline reads require explicit confirmation and target IDs");
    const unconfirmedSemantic = await client.callTool({ name: "timeline.semantic.inspect", arguments: {} });
    assert.equal(unconfirmedSemantic.isError, true, "headed semantic reads require explicit confirmation and target IDs");
    assert.equal(snapshotReads, 0, "unconfirmed timeline inspections must not export a headed snapshot");
    const wrongProjectTarget = await client.callTool({ name: "project.inspect", arguments: {
      confirmHeadedRead: true,
      expectedTarget: { projectId: "wrong", sequenceId: "wrong" },
    } });
    assert.equal(wrongProjectTarget.isError, true);
    assert.equal(JSON.parse(textFrom(wrongProjectTarget)).code, "TARGET_MISMATCH");
    assert.equal(snapshotReads, 0, "mismatched targets must fail before a headed snapshot export");
    const project = await client.callTool({ name: "project.inspect", arguments: {
      confirmHeadedRead: true,
      expectedTarget: { projectId: "final-cut:project:project-1", sequenceId: "final-cut:sequence:sequence-1" },
    } });
    assert.equal(project.isError, undefined);
    const expectedTarget = { projectId: "final-cut:project:project-1", sequenceId: "final-cut:sequence:sequence-1" };
    const timeline = await client.callTool({ name: "timeline.inspect", arguments: {
      confirmHeadedRead: true,
      expectedTarget,
    } });
    assert.equal(timeline.isError, undefined);
    assert.equal(JSON.parse(textFrom(timeline)).id, expectedTarget.sequenceId);
    const semantic = await client.callTool({ name: "timeline.semantic.inspect", arguments: {
      confirmHeadedRead: true,
      expectedTarget,
    } });
    assert.equal(semantic.isError, undefined);
    assert.equal(JSON.parse(textFrom(semantic)).timelineId, expectedTarget.sequenceId);
    const readsAfterExplicitRequest = snapshotReads;
    assert.ok(readsAfterExplicitRequest > 0);
    const afterRead = JSON.parse(textFrom(await client.callTool({ name: "editor.inspect", arguments: {} })));
    assert.equal(afterRead.capabilities.editor.timelineSnapshotRead, true);
    assert.equal(snapshotReads, readsAfterExplicitRequest, "passive status should reuse validated capability evidence");
    const laterContext = await client.callTool({ name: "context.inspect", arguments: {} });
    assert.equal(laterContext.isError, undefined);
    const passiveContext = JSON.parse(textFrom(laterContext));
    assert.equal(passiveContext.project, undefined);
    assert.equal(passiveContext.provenance.source, "live-metadata");
    assert.equal(snapshotReads, readsAfterExplicitRequest, "cached capability must not authorize another headed export");
    const passiveChanges = JSON.parse(textFrom(await client.callTool({ name: "context.changes", arguments: { revision: metadata.revision } })));
    assert.equal(passiveChanges.provenance[0].source, "live-metadata");
    await client.callTool({ name: "timeline.changes", arguments: {} });
    assert.equal(snapshotReads, readsAfterExplicitRequest, "cached capability must not authorize headed change inspection");
    const missingTarget = await client.callTool({ name: "context.inspect", arguments: { confirmHeadedRead: true } });
    assert.equal(missingTarget.isError, true);
    const wrongTarget = await client.callTool({ name: "context.inspect", arguments: {
      confirmHeadedRead: true,
      expectedTarget: { projectId: "wrong", sequenceId: "wrong" },
    } });
    assert.equal(wrongTarget.isError, true);
    assert.equal(snapshotReads, readsAfterExplicitRequest, "invalid targets must fail before headed export");
    const explicitMcpContext = await client.callTool({ name: "context.inspect", arguments: {
      confirmHeadedRead: true,
      expectedTarget: { projectId: "final-cut:project:project-1", sequenceId: "final-cut:sequence:sequence-1" },
    } });
    assert.equal(explicitMcpContext.isError, undefined);
    assert.ok(JSON.parse(textFrom(explicitMcpContext)).project);
    snapshotUnavailable = true;
    const unavailableContext = await client.callTool({ name: "context.inspect", arguments: {
      confirmHeadedRead: true,
      expectedTarget: { projectId: "final-cut:project:project-1", sequenceId: "final-cut:sequence:sequence-1" },
    } });
    assert.equal(unavailableContext.isError, true);
    assert.equal(JSON.parse(textFrom(unavailableContext)).code, "CAPABILITY_UNAVAILABLE");
    snapshotUnavailable = false;
    const readsBeforeExplicitContext = snapshotReads;
    const explicitlyRequested = await runtime.inspectContext({ probeCanonicalSnapshot: true });
    assert.ok(explicitlyRequested.project);
    assert.equal(snapshotReads, readsBeforeExplicitContext + 1, "one context request must export only once");
    const readsAfterExplicitContext = snapshotReads;
    currentLive = { ...currentLive, revision: { id: "changed", sequence: 2, timestamp: new Date(2).toISOString() } };
    const staleStatus = JSON.parse(textFrom(await client.callTool({ name: "editor.inspect", arguments: {} })));
    assert.equal(staleStatus.capabilities.editor.timelineSnapshotRead, false);
    assert.equal(snapshotReads, readsAfterExplicitContext, "stale cache detection must remain passive");
  } finally {
    await client.close();
    await server.close();
  }
});

test("canonical capability probe rejects a snapshot for another active target", async () => {
  const wrong = snapshot("Original");
  wrong.projectId = "wrong-project";
  const provider = providerFor([wrong], [], undefined, liveState(), {
    listProjects: async () => ({
      projects: [{ id: "final-cut:project:project-1", name: "Canonical E2E", sequences: [{ id: "final-cut:sequence:sequence-1", name: "Canonical E2E" }] }],
      activeProjectId: "final-cut:project:project-1", activeSequenceId: "final-cut:sequence:sequence-1",
    }),
  });
  const capabilities = await provider.getCapabilities({ probeCanonicalSnapshot: true });
  assert.equal(capabilities.editor.timelineSnapshotRead, false);
  assert.match(capabilities.families!.canonicalDocument.read.unavailableReason ?? "", /TARGET_MISMATCH/);
});

test("canonical read refreshes a probed snapshot after the live revision changes", async () => {
  let activeLive = liveState();
  let snapshotReads = 0;
  const snapshots = [snapshot("Original"), snapshot("Changed")];
  const provider = new FinalCutCanonicalNativeProvider({
    live: {
      getIdentity: async () => identity,
      readLiveState: async () => structuredClone(activeLive),
      liveChangesSince: async () => [],
    },
    native: {
      renameSelectedClip: async () => ({ operationId: "op", undoAvailable: true }),
      undo: async () => ({ undone: true }),
    },
    readSnapshot: async () => {
      snapshotReads += 1;
      const next = snapshots.shift();
      assert.ok(next, "test snapshot queue must have a fresh canonical snapshot");
      return structuredClone(next);
    },
    resolveTarget: async () => {},
    backgroundCatalog: {
      listProjects: async () => ({
        projects: [{ id: "final-cut:project:project-1", name: "Canonical E2E", sequences: [{ id: "final-cut:sequence:sequence-1", name: "Canonical E2E" }] }],
        activeProjectId: "final-cut:project:project-1",
        activeSequenceId: "final-cut:sequence:sequence-1",
      }),
    },
  });

  const probed = await provider.getCapabilities({ probeCanonicalSnapshot: true });
  assert.equal(probed.editor.timelineSnapshotRead, true);
  assert.equal(snapshotReads, 1);

  activeLive = {
    ...activeLive,
    revision: { id: "live-revision-2", sequence: 2, timestamp: new Date(2).toISOString() },
  };
  const refreshed = await provider.readProject();

  assert.equal(refreshed.timeline.clips[0]?.name, "Changed");
  assert.equal(snapshotReads, 2);
});

test("canonical read does not reuse a probe from a different request when revision misses a change", async () => {
  let reads = 0;
  const provider = new FinalCutCanonicalNativeProvider({
    live: { getIdentity: async () => identity, readLiveState: async () => liveState(), liveChangesSince: async () => [] },
    native: { renameSelectedClip: async () => ({ operationId: "op", undoAvailable: true }), undo: async () => ({ undone: true }) },
    readSnapshot: async () => snapshot(++reads === 1 ? "Original" : "Changed"),
    resolveTarget: async () => {},
    backgroundCatalog: { listProjects: async () => ({ projects: [{ id: "final-cut:project:project-1", name: "Canonical E2E", sequences: [{ id: "final-cut:sequence:sequence-1", name: "Canonical E2E" }] }], activeProjectId: "final-cut:project:project-1", activeSequenceId: "final-cut:sequence:sequence-1" }) },
  });
  assert.equal((await provider.getCapabilities({ probeCanonicalSnapshot: true })).editor.timelineSnapshotRead, true);
  const refreshed = await provider.readProject();
  assert.equal(reads, 2);
  assert.equal(refreshed.timeline.clips[0]?.name, "Changed");
});

test("direct session reads export once per request and refresh across requests", async () => {
  let reads = 0;
  const provider = new FinalCutCanonicalNativeProvider({
    live: { getIdentity: async () => identity, readLiveState: async () => liveState(), liveChangesSince: async () => [] },
    native: { renameSelectedClip: async () => ({ operationId: "op", undoAvailable: true }), undo: async () => ({ undone: true }) },
    readSnapshot: async () => snapshot(++reads === 1 ? "Original" : "Changed"),
    resolveTarget: async () => {},
    backgroundCatalog: { listProjects: async () => ({ projects: [{ id: "final-cut:project:project-1", name: "Canonical E2E", sequences: [{ id: "final-cut:sequence:sequence-1", name: "Canonical E2E" }] }], activeProjectId: "final-cut:project:project-1", activeSequenceId: "final-cut:sequence:sequence-1" }) },
  });
  const session = new FinalCutSessionAdapter({ live: provider });
  assert.equal((await session.readProject()).timeline.clips[0]?.name, "Original");
  assert.equal(reads, 1);
  assert.equal((await session.readProject()).timeline.clips[0]?.name, "Changed");
  assert.equal(reads, 2);
});

test("project service reads export once per request and refresh across requests", async () => {
  let reads = 0;
  const provider = new FinalCutCanonicalNativeProvider({
    live: { getIdentity: async () => identity, readLiveState: async () => liveState(), liveChangesSince: async () => [] },
    native: { renameSelectedClip: async () => ({ operationId: "op", undoAvailable: true }), undo: async () => ({ undone: true }) },
    readSnapshot: async () => snapshot(++reads === 1 ? "Original" : "Changed"),
    resolveTarget: async () => {},
    backgroundCatalog: { listProjects: async () => ({ projects: [{ id: "final-cut:project:project-1", name: "Canonical E2E", sequences: [{ id: "final-cut:sequence:sequence-1", name: "Canonical E2E" }] }], activeProjectId: "final-cut:project:project-1", activeSequenceId: "final-cut:sequence:sequence-1" }) },
  });
  const service = new ProjectService(provider, new ContextEngine(provider), {});
  assert.equal((await service.inspectProject()).timeline.clips[0]?.name, "Original");
  assert.equal(reads, 1);
  assert.equal((await service.inspectProject()).timeline.clips[0]?.name, "Changed");
  assert.equal(reads, 2);
});

test("concurrent canonical read scopes do not share snapshots", async () => {
  let reads = 0;
  const provider = new FinalCutCanonicalNativeProvider({
    live: { getIdentity: async () => identity, readLiveState: async () => liveState(), liveChangesSince: async () => [] },
    native: { renameSelectedClip: async () => ({ operationId: "op", undoAvailable: true }), undo: async () => ({ undone: true }) },
    readSnapshot: async () => snapshot(++reads === 1 ? "First" : "Second"),
    resolveTarget: async () => {},
  });
  let ready!: () => void;
  const bothReady = new Promise<void>((resolve) => { ready = resolve; });
  let entered = 0;
  const observe = () => provider.withCanonicalReadScope(async () => {
    const first = await provider.readProject();
    if (++entered === 2) ready();
    await bothReady;
    const second = await provider.readProject();
    assert.equal(second.timeline.clips[0]?.name, first.timeline.clips[0]?.name);
    return first.timeline.clips[0]?.name;
  });
  assert.deepEqual(new Set(await Promise.all([observe(), observe()])), new Set(["First", "Second"]));
  assert.equal(reads, 2);
});

test("a scoped canonical read refuses a changed live revision without a second export", async () => {
  let reads = 0;
  let active = liveState();
  const provider = new FinalCutCanonicalNativeProvider({
    live: { getIdentity: async () => identity, readLiveState: async () => structuredClone(active), liveChangesSince: async () => [] },
    native: { renameSelectedClip: async () => ({ operationId: "op", undoAvailable: true }), undo: async () => ({ undone: true }) },
    readSnapshot: async () => { reads++; return snapshot("Original"); },
    resolveTarget: async () => {},
  });
  await provider.withCanonicalReadScope(async () => {
    await provider.readProject();
    active = { ...active, revision: { id: "changed", sequence: 2, timestamp: new Date(2).toISOString() } };
    await assert.rejects(provider.readProject(), /FINAL_CUT_CANONICAL_TARGET_STALE/);
  });
  assert.equal(reads, 1);
});

test("canonical provider delegates supported project selection and binds later reads", async () => {
  let activeLive = liveState();
  let snapshotReads = 0;
  let selectionCalls = 0;
  const projects = [
    { id: "final-cut:project:project-1", name: "Canonical E2E", sequences: [{ id: "final-cut:sequence:sequence-1", name: "Canonical E2E" }] },
    { id: "final-cut:project:project-2", name: "Second Project", sequences: [{ id: "final-cut:sequence:sequence-2", name: "Second Sequence" }] },
    { id: "final-cut:project:project-3", name: "Ambiguous Project", sequences: [
      { id: "final-cut:sequence:sequence-3a", name: "First Sequence" },
      { id: "final-cut:sequence:sequence-3b", name: "Second Sequence" },
    ] },
  ];
  const liveCapabilities: RuntimeCapabilities = {
    editor: {
      canonicalTimelineMode: "metadata-only",
      projectRead: false,
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
      projectSelection: true,
      projectSelectionMode: "headed-only",
      backgroundLibraryInspection: true,
    },
    analyzers: { speechTranscribe: false, speechVad: false, audioLoudness: false, visualTrack: false },
  };
  const projectCatalog = () => ({
    projects,
    activeProjectId: activeLive.project!.id,
    activeSequenceId: activeLive.sequence!.id,
  });
  const provider = new FinalCutCanonicalNativeProvider({
    live: {
      getIdentity: async () => identity,
      getCapabilities: async () => liveCapabilities,
      readLiveState: async () => structuredClone(activeLive),
      liveChangesSince: async () => [],
      selectProject: async (selection) => {
        selectionCalls += 1;
        assert.ok(selection.sequenceId, "project selection must be bound to a sequence");
        const selectedProject = projects.find(({ id }) => id === selection.projectId)!;
        const selectedSequence = selectedProject.sequences.find(({ id }) => id === selection.sequenceId)!;
        activeLive = {
          ...activeLive,
          project: { id: selectedProject.id, name: selectedProject.name },
          sequence: {
            id: selectedSequence.id,
            name: selectedSequence.name,
            startTime: { value: "0", timescale: "24" },
            duration: { value: "96", timescale: "24" },
            frameDuration: { value: "1", timescale: "24" },
          },
          revision: { id: "live-revision-2", sequence: 2, timestamp: new Date(2).toISOString() },
        };
        return {
          ...projectCatalog(),
          requestedTarget: { projectId: selection.projectId, sequenceId: selection.sequenceId },
          observedActiveTarget: { projectId: selection.projectId, sequenceId: selection.sequenceId },
          observedRevision: { ...activeLive.revision },
        } satisfies ProjectSelectionResult;
      },
    },
    native: {
      renameSelectedClip: async () => ({ operationId: "op", undoAvailable: true }),
      undo: async () => ({ undone: true }),
    },
    readSnapshot: async () => {
      snapshotReads += 1;
      const result = snapshot("Original");
      result.projectId = activeLive.project!.id;
      result.projectName = activeLive.project!.name;
      result.timeline.id = activeLive.sequence!.id;
      result.timeline.name = activeLive.sequence!.name;
      return result;
    },
    resolveTarget: async () => {},
    backgroundCatalog: { listProjects: async () => projectCatalog() },
  });
  const runtime = new Runtime(new FinalCutSessionAdapter({ live: provider }));
  const sessionCapabilities = await new FinalCutSessionAdapter({ live: provider }).getCapabilities({
    probeCanonicalSnapshot: false,
  });
  assert.equal(sessionCapabilities.editor.projectSelection, true);
  assert.equal(sessionCapabilities.editor.projectSelectionMode, "headed-only");

  const catalog = await runtime.listProjects();
  assert.equal(catalog.provenance?.selection.available, true);
  assert.equal(catalog.provenance?.selection.mode, "headed-only");
  const sessionCatalog = await new Runtime(new FinalCutSessionAdapter({
    live: provider,
    backgroundCatalog: { listProjects: async () => projectCatalog() },
  })).listProjects();
  assert.equal(sessionCatalog.provenance?.selection.available, true);
  assert.equal(sessionCatalog.provenance?.selection.mode, "headed-only");

  const snapshotWithoutSelection = {
    getIdentity: () => provider.getIdentity(),
    getCapabilities: () => provider.getCapabilities({ probeCanonicalSnapshot: false }),
    read: () => provider.read(),
    readProject: () => provider.readProject(),
    apply: provider.apply.bind(provider),
    restore: provider.restore.bind(provider),
  };
  const mixedSession = new FinalCutSessionAdapter({
    live: provider,
    snapshot: snapshotWithoutSelection,
    backgroundCatalog: { listProjects: async () => projectCatalog() },
  });
  const mixedCatalog = await mixedSession.listProjects();
  assert.equal((await mixedSession.getCapabilities({ probeCanonicalSnapshot: false })).editor.projectSelection, false);
  assert.equal(mixedCatalog.provenance?.selection.available, false);
  assert.equal(mixedCatalog.provenance?.selection.mode, "unavailable");
  await assert.rejects(mixedSession.selectProject({ projectId: projects[0]!.id }), /CAPABILITY_UNAVAILABLE/);

  const capabilities = await provider.getCapabilities({ probeCanonicalSnapshot: false });
  assert.equal(capabilities.editor.projectSelection, true);
  assert.equal(capabilities.editor.projectSelectionMode, "headed-only");
  assert.equal(snapshotReads, 0);

  await assert.rejects(
    runtime.selectProject({ projectId: "final-cut:project:project-3" }),
    /AMBIGUOUS_PROJECT_TARGET: sequenceId is required/,
  );
  assert.equal(selectionCalls, 0);
  assert.equal(snapshotReads, 0);

  await provider.readProject();
  assert.equal((await provider.getCapabilities({ probeCanonicalSnapshot: false })).editor.timelineSnapshotRead, true);
  snapshotReads = 0;

  const selected = await runtime.selectProject({
    projectId: "final-cut:project:project-2",
    sequenceId: "final-cut:sequence:sequence-2",
  });
  assert.deepEqual(selected.observedActiveTarget, {
    projectId: "final-cut:project:project-2",
    sequenceId: "final-cut:sequence:sequence-2",
  });
  assert.equal(selectionCalls, 1);
  assert.equal(snapshotReads, 0, "selection must not export the timeline");

  const selectedLive = activeLive;
  activeLive = liveState();
  assert.equal((await provider.getCapabilities({ probeCanonicalSnapshot: false })).editor.timelineSnapshotRead, false);
  await assert.rejects(provider.readProject(), /TARGET_MISMATCH/);
  activeLive = selectedLive;

  const selectedSnapshot = await provider.readProject();
  assert.equal(selectedSnapshot.projectId, "final-cut:project:project-2");
  assert.equal(selectedSnapshot.timeline.id, "final-cut:sequence:sequence-2");
  assert.equal(snapshotReads, 1);

  activeLive = liveState();
  await assert.rejects(provider.readProject(), /TARGET_MISMATCH: active project or sequence differs from the explicitly selected target/);
  assert.equal(snapshotReads, 1, "a switched target must be rejected before a new export");
});

test("MCP canonical session resync requires headed target confirmation", async () => {
  let snapshotReads = 0;
  const provider = new FinalCutCanonicalNativeProvider({
    live: { ...liveWithoutBackgroundCatalog(), readLiveState: async () => structuredClone(liveState()) },
    native: { renameSelectedClip: async () => ({ operationId: "op", undoAvailable: true }), undo: async () => ({ undone: true }) },
    readSnapshot: async () => { snapshotReads++; return snapshot("Original"); },
    resolveTarget: async () => {},
    backgroundCatalog: { listProjects: async () => ({
      projects: [{ id: "final-cut:project:project-1", name: "Canonical E2E", sequences: [{ id: "final-cut:sequence:sequence-1", name: "Canonical E2E" }] }],
      activeProjectId: "final-cut:project:project-1", activeSequenceId: "final-cut:sequence:sequence-1",
    }) },
  });
  const runtime = new Runtime(new FinalCutSessionAdapter({ live: provider }));
  const sessionDirectory = await mkdtemp(join(tmpdir(), "framekit-headed-resync-"));
  const server = createMcpServer(runtime, { processMode: "headed", sessionDirectory });
  const client = new Client({ name: "headed-session-resync", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const base = createTimelineIrFromProjectSnapshot(await runtime.inspectProject(), { id: "final-cut" });
    const created = await client.callTool({ name: "session.create", arguments: {
      sessionId: "resync-session", provider: { id: "final-cut" }, base,
    } });
    assert.equal(created.isError, undefined, textFrom(created));
    snapshotReads = 0;
    const unconfirmed = await client.callTool({ name: "project.inspect", arguments: {
      sessionId: "resync-session", requestedCanonical: true,
    } });
    assert.equal(unconfirmed.isError, true);
    assert.equal(JSON.parse(textFrom(unconfirmed)).code, "HEADED_READ_CONFIRMATION_REQUIRED");
    assert.equal(snapshotReads, 0);
    const confirmed = await client.callTool({ name: "project.inspect", arguments: {
      sessionId: "resync-session",
      requestedCanonical: true,
      confirmHeadedRead: true,
      expectedTarget: { projectId: "final-cut:project:project-1", sequenceId: "final-cut:sequence:sequence-1" },
    } });
    assert.equal(confirmed.isError, undefined);
    assert.equal(JSON.parse(textFrom(confirmed)).snapshot.projectId, "final-cut:project:project-1");
    assert.ok(snapshotReads > 0, "confirmed session resync performs the canonical read");
  } finally {
    await client.close();
    await server.close();
    await rm(sessionDirectory, { recursive: true, force: true });
  }
});

test("native reservations share the canonical checkpoint and survive lost owners", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-native-reservation-"));
  try {
    const path = join(directory, "pending.json");
    const direct = new FileCanonicalRecoveryGuard(path);
    const other = new FileCanonicalRecoveryGuard(path);
    const checkpoint = { projectId: "project-1", sequenceId: "sequence-1", baseRevision: "rev-1", beforeDigest: "a".repeat(64), operation: "rename-clip" };
    const reservation = await direct.beginNative("editor.native.edit");
    const evidence = await other.inspectNativeReservation();
    assert.equal(evidence?.operation, "editor.native.edit");
    assert.match(evidence!.reservationId, /^[a-f0-9]{64}$/);
    assert.equal(reservation.reservationId, evidence?.reservationId);
    await assert.rejects(other.begin(checkpoint), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    await assert.rejects(other.beginNative("editor.native.undo"), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    await assert.rejects(other.complete(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    await reservation.release();
    await other.begin(checkpoint);
    await assert.rejects(direct.beginNative("editor.native.edit"), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    await other.complete();
    const displaced = await direct.beginNative("editor.native.edit");
    await rm(path);
    const replacement = await other.beginNative("editor.native.edit");
    assert.notEqual(displaced.reservationId, replacement.reservationId);
    await assert.rejects(displaced.release(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    assert.equal((await direct.inspectNativeReservation())?.reservationId, replacement.reservationId);
    await replacement.release();
    await direct.beginNative("editor.native.edit");
    const restarted = new FileCanonicalRecoveryGuard(path);
    assert.equal((await restarted.inspectNativeReservation())?.operation, "editor.native.edit");
    await assert.rejects(restarted.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    const record = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...record, operation: "../unsafe" }));
    await assert.rejects(restarted.inspectNativeReservation(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("canonical resolver rejects mismatched native identity before selecting an occurrence", async () => {
  for (const mismatch of ["sequence", "source", "missing-sequence"] as const) {
    const selected: string[] = [];
    const native = {
      searchMedia: async () => [{ handle: "media-handle", name: "clip.mov", sourceIdentity: "browser-source-1", source: "/tmp/clip.mov" }],
      locateOccurrence: async () => ({ status: "unique" as const, occurrences: [{
        handle: "occurrence-handle", mediaHandle: "media-handle", name: "Original", identity: "native-occurrence-1",
        start: "0/24", duration: "96/24",
        ...(mismatch !== "missing-sequence" ? { sequenceId: mismatch === "sequence" ? "other-sequence" : "final-cut:sequence:sequence-1" } : {}),
        sourceIdentity: mismatch === "source" ? "other-source" : "browser-source-1",
      }] }),
      selectOccurrence: async (handle: string) => { selected.push(handle); return {} as never; },
    };
    const project = snapshot("Original");
    await assert.rejects(createFinalCutNativeTargetResolver(native)(project.timeline.clips[0]!, project), /TARGET_MISMATCH/, mismatch);
    assert.deepEqual(selected, [], mismatch);
  }
});

test("canonical resolver rejects ambiguous or incomplete coordinates before native discovery", async () => {
  for (const kind of ["same-source", "source-alias", "missing", "invalid"] as const) {
    const project = snapshot("Original");
    const target = project.timeline.clips[0]!;
    const other = { ...target, id: "other-occurrence", mediaId: kind === "source-alias" ? "alias-media" : target.mediaId, track: 1,
      startTime: kind === "invalid" ? { value: "0", timescale: "0" } : { value: "0", timescale: "48" },
      durationTime: { value: "192", timescale: "48" },
    };
    if (kind === "source-alias") project.media.push({ mediaId: "alias-media", source: "file:///tmp/clip.mov" });
    if (kind === "missing") Reflect.deleteProperty(other, "startTime");
    project.timeline.clips.push(other);
    const calls: string[] = [];
    const native = {
      searchMedia: async () => { calls.push("search"); return []; },
      locateOccurrence: async () => { calls.push("locate"); return { status: "none" as const, occurrences: [] }; },
      selectOccurrence: async () => { calls.push("select"); return {} as never; },
    };
    await assert.rejects(createFinalCutNativeTargetResolver(native)(target, project), /AMBIGUOUS_PROJECT_TARGET.*coordinates/i);
    assert.deepEqual(calls, []);
  }
});

test("canonical resolver ignores unrelated media coordinates", async () => {
  for (const coordinates of ["overlapping", "missing", "invalid"] as const) {
    const project = snapshot("Original");
    const target = project.timeline.clips[0]!;
    const other = { ...target, id: "other", mediaId: "other-media", track: 1 };
    project.media.push({ mediaId: "other-media", source: "/tmp/other.mov" });
    if (coordinates === "missing") Reflect.deleteProperty(other, "startTime");
    if (coordinates === "invalid") other.startTime = { value: "0", timescale: "0" };
    project.timeline.clips.push(other);
    const selected: string[] = [];
    const native = {
      searchMedia: async () => [{ handle: "media", name: "clip.mov", sourceIdentity: "source", source: "/tmp/clip.mov" }],
      locateOccurrence: async () => ({ status: "unique" as const, occurrences: [{ handle: "occ", mediaHandle: "media", name: "Original", identity: "item", sourceIdentity: "source", start: "0/24", duration: "96/24", sequenceId: project.timeline.id }] }),
      selectOccurrence: async (handle: string) => { selected.push(handle); return { target: { kind: "selected-clip", identity: "item" } } as never; },
    };
    await createFinalCutNativeTargetResolver(native)(target, project);
    assert.deepEqual(selected, ["occ"], coordinates);
  }
});

test("canonical resolver classifies unknown capabilities before selection", async () => {
  const project = snapshot("Original");
  let selected = false;
  const native = {
    capabilities: () => { throw new Error("unclassified provider failure"); },
    searchMedia: async () => [{ handle: "media", name: "clip.mov", sourceIdentity: "source", source: "/tmp/clip.mov" }],
    locateOccurrence: async () => ({ status: "unique" as const, occurrences: [{ handle: "occ", mediaHandle: "media", name: "Original", identity: "item", sourceIdentity: "source", start: "0/24", duration: "96/24", sequenceId: project.timeline.id }] }),
    selectOccurrence: async () => { selected = true; return {} as never; },
  };
  await assert.rejects(createFinalCutNativeTargetResolver(native)(project.timeline.clips[0]!, project), /TARGET_MISMATCH/);
  assert.equal(selected, false);
});

test("canonical target preparation is protected by the recovery checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-target-preparation-race-"));
  const path = join(directory, "pending.json");
  const guard = new FileCanonicalRecoveryGuard(path);
  const other = new FileCanonicalRecoveryGuard(path);
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { finish = resolve; });
  const provider = providerFor([snapshot("Original"), snapshot("Original"), snapshot("Renamed")], [], Object.assign(async () => {
    entered();
    await held;
  }, { sourceBindingAvailable: true }), liveState(), undefined, {}, guard);
  const before = await provider.readProject();
  const edit = provider.apply({ type: "rename-clip", clipId: "final-cut:occurrence:clip-1", name: "Renamed" }, before.revision);
  try {
    await started;
    try {
      await assert.rejects(other.beginNative("native.selectoccurrence"), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    } finally { finish(); }
    await edit;
    await guard.assertClear();
  } finally {
    finish();
    await edit.catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("uncertain target preparation keeps its checkpoint without dispatching an edit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-target-preparation-failure-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const calls: string[] = [];
  const provider = providerFor([snapshot("Original"), snapshot("Original")], calls, Object.assign(async () => {
    throw new Error("native selection outcome unknown");
  }, { sourceBindingAvailable: true }), liveState(), undefined, {}, guard);
  try {
    const before = await provider.readProject();
    await assert.rejects(provider.apply({ type: "rename-clip", clipId: "final-cut:occurrence:clip-1", name: "Renamed" }, before.revision), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
    assert.deepEqual(calls, []);
    assert.equal((await guard.inspectVersioned())?.checkpoint.operation, "rename-clip");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("target validation that fails before native dispatch releases its checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-target-preflight-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const calls: string[] = [];
  const resolveTarget = Object.assign(async () => { throw new Error("TARGET_MISMATCH: missing media binding"); }, {
    sourceBindingAvailable: true,
    trackNativeDispatch: async <T>(operation: () => Promise<T>) => operation(),
  });
  const provider = providerFor([snapshot("Original"), snapshot("Original")], calls, resolveTarget, liveState(), undefined, {}, guard);
  try {
    const before = await provider.readProject();
    await assert.rejects(provider.apply({ type: "rename-clip", clipId: "final-cut:occurrence:clip-1", name: "Renamed" }, before.revision), /TARGET_MISMATCH: missing media binding/);
    assert.deepEqual(calls, []);
    await guard.assertClear();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("target preparation revision drift remains blocked before canonical dispatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-target-preparation-drift-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const calls: string[] = [];
  const active = liveState();
  const provider = providerFor([snapshot("Original"), snapshot("Original")], calls, Object.assign(async () => {
    active.revision.id = "changed-during-target-preparation";
  }, { sourceBindingAvailable: true }), active, undefined, {}, guard);
  try {
    const before = await provider.readProject();
    await assert.rejects(provider.apply({ type: "rename-clip", clipId: "final-cut:occurrence:clip-1", name: "Renamed" }, before.revision), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED.*TARGET_STALE/);
    assert.deepEqual(calls, []);
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("canonical resolver rejects selection that changes a known native occurrence identity", async () => {
  const occurrence = {
    handle: "occurrence-handle", mediaHandle: "media-handle", name: "Original", nativeIdentity: "expected-native-identity",
    start: "0/24", duration: "96/24", sequenceId: "final-cut:sequence:sequence-1", sourceIdentity: "browser-source-1",
  };
  const native = {
    searchMedia: async () => [{ handle: "media-handle", name: "clip.mov", sourceIdentity: "browser-source-1", source: "/tmp/clip.mov" }],
    locateOccurrence: async () => ({ status: "unique" as const, occurrences: [occurrence] }),
    selectOccurrence: async () => {
      occurrence.nativeIdentity = "different-native-identity";
      return { target: { kind: "selected-clip", identity: "different-native-identity" } } as never;
    },
  };
  const project = snapshot("Original");
  await assert.rejects(createFinalCutNativeTargetResolver(native)(project.timeline.clips[0]!, project), /TARGET_MISMATCH.*selected.*identity/i);
});

test("canonical resolver uses nonselecting discovery before identity validation", async () => {
  const calls: string[] = [];
  const native = {
    searchMedia: async () => [{ handle: "media-handle", name: "clip.mov", sourceIdentity: "browser-source-1", source: "/tmp/clip.mov" }],
    locateOccurrence: async () => { calls.push("ordinary-locate"); throw new Error("ordinary locate may select"); },
    locateOccurrenceForCanonicalTarget: async () => {
      calls.push("canonical-locate");
      return { status: "unique" as const, occurrences: [{ handle: "occurrence-handle", mediaHandle: "media-handle", name: "Original", identity: "native-1", start: "0/24", duration: "96/24", sequenceId: "other-sequence", sourceIdentity: "browser-source-1" }] };
    },
    selectOccurrence: async () => { calls.push("select"); return {} as never; },
  };
  const project = snapshot("Original");
  await assert.rejects(createFinalCutNativeTargetResolver(native)(project.timeline.clips[0]!, project), /TARGET_MISMATCH/);
  assert.deepEqual(calls, ["canonical-locate"]);
});

test("canonical resolver rejects incomplete discovered occurrence coordinates before selection", async () => {
  for (const coordinates of [{ duration: "96/24" }, { start: "0/24" }, { start: "invalid", duration: "96/24" }, { start: "0/24", duration: "1/0" }]) {
    const calls: string[] = [];
    const project = snapshot("Original");
    const occurrence = { handle: "occ", mediaHandle: "media", name: "Original", identity: "item", sourceIdentity: "source", start: "0/24", duration: "96/24", sequenceId: project.timeline.id };
    const native = {
      searchMedia: async () => [{ handle: "media", name: "clip.mov", sourceIdentity: "source", source: "/tmp/clip.mov" }],
      locateOccurrence: async () => ({ status: "ambiguous" as const, occurrences: [occurrence, { ...occurrence, handle: "other", start: coordinates.start, duration: coordinates.duration }] }),
      selectOccurrence: async () => { calls.push("select"); return { target: { kind: "selected-clip", identity: "item" } } as never; },
    };
    await assert.rejects(createFinalCutNativeTargetResolver(native)(project.timeline.clips[0]!, project), /AMBIGUOUS_PROJECT_TARGET.*coordinates/i);
    assert.deepEqual(calls, []);
  }
});

test("canonical resolver compares the discovered occurrence identity after selection", async () => {
  const native = {
    searchMedia: async () => [{ handle: "media-handle", name: "clip.mov", sourceIdentity: "browser-source-1", source: "/tmp/clip.mov" }],
    locateOccurrence: async () => ({ status: "unique" as const, occurrences: [{ handle: "occurrence-handle", mediaHandle: "media-handle", name: "Original", identity: "expected-native-id", sourceIdentity: "browser-source-1", start: "0/24", duration: "96/24", sequenceId: "final-cut:sequence:sequence-1" }] }),
    selectOccurrence: async () => ({ target: { kind: "selected-clip", identity: "different-native-id" } }) as never,
  };
  const project = snapshot("Original");
  await assert.rejects(createFinalCutNativeTargetResolver(native)(project.timeline.clips[0]!, project), /TARGET_MISMATCH.*selected.*identity/i);
});

test("canonical resolver rejects identity-free occurrences before selecting", async () => {
  let selected = false;
  const native = {
    searchMedia: async () => [{ handle: "media-handle", name: "clip.mov", sourceIdentity: "browser-source-1", source: "/tmp/clip.mov" }],
    locateOccurrence: async () => ({ status: "unique" as const, occurrences: [{ handle: "occurrence-handle", mediaHandle: "media-handle", name: "Original", start: "0/24", duration: "96/24", sequenceId: "final-cut:sequence:sequence-1" }] }),
    selectOccurrence: async () => { selected = true; return {} as never; },
  };
  const project = snapshot("Original");
  await assert.rejects(createFinalCutNativeTargetResolver(native)(project.timeline.clips[0]!, project), /TARGET_MISMATCH.*stable identity/);
  assert.equal(selected, false);
});

test("canonical resolver rejects a timeline occurrence without observed source identity", async () => {
  let selected = false;
  const native = {
    searchMedia: async () => [{ handle: "media-handle", name: "clip.mov", sourceIdentity: "browser-source-1", source: "/tmp/clip.mov" }],
    locateOccurrence: async () => ({ status: "unique" as const, occurrences: [{ handle: "occurrence-handle", mediaHandle: "media-handle", name: "Original", identity: "native-1", start: "0/24", duration: "96/24", sequenceId: "final-cut:sequence:sequence-1" }] }),
    selectOccurrence: async () => { selected = true; return { target: { kind: "selected-clip", identity: "native-1" } } as never; },
  };
  const project = snapshot("Original");
  await assert.rejects(createFinalCutNativeTargetResolver(native)(project.timeline.clips[0]!, project), /TARGET_MISMATCH.*source identity/i);
  assert.equal(selected, false);
});

test("source-capable resolver requires matching selected Inspector evidence", async () => {
  for (const mismatch of ["path", "range", "duration", "identity", "missing", "missing-path", "missing-range", "invalid-range", "missing-duration"] as const) {
    const project = snapshot("Original");
    project.timeline.clips[0]!.sourceStartTime = { value: "120", timescale: "24" };
    const native = {
      capabilities: () => ({ timelineOccurrenceSourceBinding: true }) as never,
      searchMedia: async () => [{ handle: "media", name: "clip.mov", sourceIdentity: "source", source: "/tmp/clip.mov" }],
      locateOccurrence: async () => ({ status: "unique" as const, occurrences: [{ handle: "occ", mediaHandle: "media", name: "Original", identity: "item", sourceIdentity: "source", start: "0/24", duration: "96/24", sequenceId: project.timeline.id }] }),
      selectOccurrence: async () => ({ target: { kind: "selected-clip", identity: "item" } }) as never,
      inspectSelectedOccurrenceSource: async () => mismatch === "missing" ? undefined : ({ identity: mismatch === "identity" ? "other" : "item", source: mismatch === "missing-path" ? undefined as never : mismatch === "path" ? "/other/clip.mov" : "/tmp/clip.mov", sourceStartTime: mismatch === "missing-range" ? undefined as never : { value: mismatch === "range" ? "6" : "5", timescale: mismatch === "invalid-range" ? "0" : "1" }, durationTime: mismatch === "missing-duration" ? undefined as never : { value: mismatch === "duration" ? "3" : "4", timescale: "1" } }),
    };
    await assert.rejects(createFinalCutNativeTargetResolver(native)(project.timeline.clips[0]!, project), /TARGET_MISMATCH.*Inspector/i, mismatch);
  }
});

test("source-capable resolver rejects a missing canonical source range before selection", async () => {
  let selected = false;
  const project = snapshot("Original");
  const native = {
    capabilities: () => ({ timelineOccurrenceSourceBinding: true }) as never,
    searchMedia: async () => [{ handle: "media", name: "clip.mov", sourceIdentity: "source", source: "/tmp/clip.mov" }],
    locateOccurrence: async () => ({ status: "unique" as const, occurrences: [{ handle: "occ", mediaHandle: "media", name: "Original", identity: "item", sourceIdentity: "source", start: "0/24", duration: "96/24", sequenceId: project.timeline.id }] }),
    selectOccurrence: async () => { selected = true; return {} as never; },
    inspectSelectedOccurrenceSource: async () => undefined,
  };
  await assert.rejects(createFinalCutNativeTargetResolver(native)(project.timeline.clips[0]!, project), /TARGET_MISMATCH.*Inspector/);
  assert.equal(selected, false);
});

test("canonical capabilities fail closed when source binding is unavailable", async () => {
  const calls: string[] = [];
  const resolveTarget = Object.assign(async () => { calls.push("resolve"); }, { sourceBindingAvailable: false });
  const provider = providerFor([snapshot("Original"), snapshot("Original"), snapshot("Original"), snapshot("Original")], calls, resolveTarget, liveState(), {
    listProjects: async () => ({ projects: [{ id: "final-cut:project:project-1", name: "Canonical E2E", sequences: [{ id: "final-cut:sequence:sequence-1", name: "Canonical E2E" }] }], activeProjectId: "final-cut:project:project-1", activeSequenceId: "final-cut:sequence:sequence-1" }),
  }, { addMarkerAtTime: async () => ({ operationId: "marker-1", undoAvailable: true }) });
  const capabilities = await provider.getCapabilities({ probeCanonicalSnapshot: true });
  assert.notEqual(capabilities.editor.semanticOperations?.["rename-clip"], true);
  assert.notEqual(capabilities.editor.semanticOperations?.["trim-clip"], true);
  assert.notEqual(capabilities.editor.semanticOperations?.["set-gain"], true);
  assert.notEqual(capabilities.editor.semanticOperations?.["ripple-delete"], true);
  const before = await provider.readProject();
  await assert.rejects(provider.previewTransaction([{ type: "rename-clip", clipId: before.timeline.clips[0]!.id, name: "Renamed" }], before.revision), /CAPABILITY_UNAVAILABLE.*source/i);
  await assert.rejects(provider.apply({ type: "rename-clip", clipId: before.timeline.clips[0]!.id, name: "Renamed" }, before.revision), /CAPABILITY_UNAVAILABLE.*source/i);
  assert.deepEqual(calls, []);
});

test("every source-bound operation rejects unavailable binding before dispatch", async () => {
  const cases = [
    { before: snapshot("Original"), operation: { type: "rename-clip" as const, clipId: "final-cut:occurrence:clip-1", name: "Renamed" } },
    { before: snapshot("Original"), operation: { type: "trim-clip" as const, clipId: "final-cut:occurrence:clip-1", duration: 3, durationTime: { value: "72", timescale: "24" } } },
    { before: rippleSnapshots().before, operation: { type: "ripple-delete" as const, timelineId: "final-cut:sequence:sequence-1", range: { start: 2, end: 4, startTime: { value: "48", timescale: "24" }, durationTime: { value: "48", timescale: "24" } }, candidateId: "filler-1", reason: "remove verified filler" } },
    { before: gainSnapshots().before, operation: { type: "set-gain" as const, clipId: "final-cut:occurrence:clip-1", gainDb: 3 } },
  ];
  for (const { before: original, operation } of cases) {
    const calls: string[] = [];
    const resolveTarget = Object.assign(async () => { calls.push("resolve"); }, { sourceBindingAvailable: false });
    const mutate = async () => { calls.push("dispatch"); return { operationId: "unexpected", undoAvailable: true }; };
    const provider = providerFor([original, original, original], calls, resolveTarget, liveState(), undefined, {
      renameSelectedClip: mutate, trimSelectedClipToRange: mutate, rippleDeleteRange: mutate, setSelectedClipGain: mutate,
    });
    const before = await provider.readProject();
    await assert.rejects(provider.previewTransaction([operation], before.revision), /CAPABILITY_UNAVAILABLE.*source/i, operation.type);
    await assert.rejects(provider.apply(operation, before.revision), /CAPABILITY_UNAVAILABLE.*source/i, operation.type);
    assert.deepEqual(calls, [], operation.type);
  }
});

test("source capability limits only source-bound operations when canonical readiness is otherwise available", async () => {
  const resolveTarget = Object.assign(async () => {}, { sourceBindingAvailable: false });
  const provider = new FinalCutCanonicalNativeProvider({
    live: {
      getIdentity: async () => identity,
      readLiveState: async () => liveState(),
      liveChangesSince: async () => [],
      getCapabilities: async () => ({ editor: { projectSelection: true, projectSelectionMode: "headed-only" } }) as never,
      selectProject: async () => ({} as never),
    },
    native: {
      renameSelectedClip: async () => ({ operationId: "rename", undoAvailable: true }),
      trimSelectedClipToRange: async () => ({ operationId: "trim", undoAvailable: true }),
      addMarkerAtTime: async () => ({ operationId: "marker", undoAvailable: true }),
      rippleDeleteRange: async () => ({ operationId: "ripple", undoAvailable: true }),
      setSelectedClipGain: async () => ({ operationId: "gain", undoAvailable: true }),
      undo: async () => ({ undone: true, verification: { verified: true } }),
    },
    readSnapshot: async () => snapshot("Original"),
    resolveTarget,
    backgroundCatalog: { listProjects: async () => ({ projects: [{ id: "final-cut:project:project-1", name: "Canonical E2E", sequences: [{ id: "final-cut:sequence:sequence-1", name: "Canonical E2E" }] }], activeProjectId: "final-cut:project:project-1", activeSequenceId: "final-cut:sequence:sequence-1" }) },
  });
  const capabilities = await provider.getCapabilities({ probeCanonicalSnapshot: true });
  assert.equal(capabilities.editor.timelineSnapshotRead, true);
  assert.equal(capabilities.editor.semanticOperations?.["add-marker"], true);
  for (const operation of ["rename-clip", "trim-clip", "ripple-delete", "set-gain"] as const) {
    assert.equal(capabilities.editor.semanticOperations?.[operation], false, operation);
  }
  delete (resolveTarget as CanonicalNativeTargetResolver).sourceBindingAvailable;
  const undeclared = await provider.getCapabilities({ probeCanonicalSnapshot: true });
  assert.equal(undeclared.editor.semanticOperations?.["rename-clip"], false);
  Object.defineProperty(resolveTarget, "sourceBindingAvailable", { get: () => { throw new Error("provider unavailable"); } });
  const unavailable = await provider.getCapabilities({ probeCanonicalSnapshot: true });
  assert.equal(unavailable.editor.semanticOperations?.["rename-clip"], false);
  assert.equal(unavailable.editor.semanticOperations?.["add-marker"], true);
});

test("canonical single-edit readiness never advertises recoverable batches through MCP", async () => {
  const calls: string[] = [];
  const original = snapshot("Original");
  const active = liveState();
  const provider = new FinalCutCanonicalNativeProvider({
    live: {
      ...liveWithoutBackgroundCatalog(),
      getCapabilities: async () => ({ editor: { projectSelection: true, projectSelectionMode: "headed-only" } }) as never,
      selectProject: async () => { throw new Error("unexpected selection"); },
    },
    native: {
      renameSelectedClip: async () => { calls.push("edit"); return { operationId: "edit", undoAvailable: true }; },
      undo: async () => { calls.push("undo"); return { undone: true, verification: { verified: true } }; },
    },
    readSnapshot: async () => structuredClone(original),
    resolveTarget: Object.assign(async () => { calls.push("resolve"); }, { sourceBindingAvailable: true }),
    backgroundCatalog: { listProjects: async () => ({ projects: [{ id: active.project!.id, name: active.project!.name, sequences: [{ id: active.sequence!.id, name: active.sequence!.name }] }], activeProjectId: active.project!.id, activeSequenceId: active.sequence!.id }) },
  });
  const session = new FinalCutSessionAdapter({ live: provider });
  for (const adapter of [provider, session]) {
    const capabilities = await adapter.getCapabilities();
    assert.equal(capabilities.editor.timelineWrite, true, "the fixture has full single-edit readiness");
    assert.equal(capabilities.editor.compositeTransactions, false);
    assert.equal(capabilities.families?.editing.compositeTransactions.available, false);
  }
  const runtime = new Runtime(session);
  const server = createMcpServer(runtime, { processMode: "headed" });
  const client = new Client({ name: "canonical-batch-capability", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const inspected = JSON.parse(textFrom(await client.callTool({ name: "editor.inspect", arguments: {} })));
    assert.equal(inspected.capabilities.editor.compositeTransactions, false);
    for (const skill of ["filler-removal", "dialogue-normalization"]) {
      const result = JSON.parse(textFrom(await client.callTool({ name: "skill.inspect", arguments: { skill } })));
      assert.equal(result.availability.available, false);
      assert.ok(result.availability.missingRequirements.some((missing: { name: string }) => missing.name === "compositeTransactions"));
    }
    const before = await provider.readProject();
    const operation = { type: "rename-clip" as const, clipId: before.timeline.clips[0]!.id, name: "Renamed" };
    for (const operations of [[], [operation, { ...operation, name: "Again" }]]) {
      await assert.rejects(provider.previewTransaction(operations, before.revision), /CAPABILITY_UNAVAILABLE/);
      await assert.rejects(provider.applyTransaction(operations, before.revision), /CAPABILITY_UNAVAILABLE/);
      await assert.rejects(runtime.previewEdit({ baseRevision: before.revision, operations }), /CAPABILITY_UNAVAILABLE/);
    }
    assert.equal(canonicalSnapshotDigest(await provider.readProject()), canonicalSnapshotDigest(before));
    assert.deepEqual(calls, []);
  } finally {
    await client.close();
    await server.close();
  }
});

test("production canonical resolver reports source binding unavailable", () => {
  const resolver = createFinalCutNativeTargetResolver({
    searchMedia: async () => [],
    locateOccurrence: async () => ({ status: "none", occurrences: [] }),
  });
  assert.equal(resolver.sourceBindingAvailable, false);
});

test("canonical source binding is enabled only for an explicitly capable nonselecting provider", async () => {
  const occurrence = { handle: "occurrence-handle", mediaHandle: "media-handle", name: "Original", identity: "native-1", sourceIdentity: "browser-source-1", start: "0/24", duration: "96/24", sequenceId: "final-cut:sequence:sequence-1" };
  const locate = async () => ({ status: "unique" as const, occurrences: [occurrence] });
  let sourceAvailable = true;
  const native = {
    capabilities: () => ({ timelineOccurrenceSourceBinding: sourceAvailable }) as never,
    searchMedia: async () => [{ handle: "media-handle", name: "clip.mov", sourceIdentity: "browser-source-1", source: "/tmp/clip.mov" }],
    locateOccurrence: locate,
    locateOccurrenceForCanonicalTarget: locate,
    selectOccurrence: async () => ({ target: { kind: "selected-clip", identity: "native-1" } }) as never,
    inspectSelectedOccurrenceSource: async () => ({ identity: "native-1", source: "/tmp/clip.mov", sourceStartTime: { value: "0", timescale: "1" }, durationTime: { value: "4", timescale: "1" } }),
  };
  const project = snapshot("Original");
  project.timeline.clips[0]!.sourceStartTime = { value: "0", timescale: "1" };
  const resolver = createFinalCutNativeTargetResolver(native);
  assert.equal(resolver.sourceBindingAvailable, true);
  await resolver(project.timeline.clips[0]!, project);
  sourceAvailable = false;
  assert.equal(resolver.sourceBindingAvailable, false);
  sourceAvailable = true;
  const { locateOccurrenceForCanonicalTarget: _removed, ...withoutDedicatedLocator } = native;
  assert.equal(createFinalCutNativeTargetResolver(withoutDedicatedLocator).sourceBindingAvailable, false);
  const { selectOccurrence: _removedSelector, ...withoutSelector } = native;
  const unsafe = createFinalCutNativeTargetResolver(withoutSelector);
  assert.equal(unsafe.sourceBindingAvailable, false);
  await assert.rejects(unsafe(project.timeline.clips[0]!, project), /TARGET_MISMATCH.*selection/i);
  const { inspectSelectedOccurrenceSource: _removedInspector, ...withoutInspector } = native;
  assert.equal(createFinalCutNativeTargetResolver(withoutInspector).sourceBindingAvailable, false);
  assert.equal(createFinalCutNativeTargetResolver({ ...native, capabilities: () => ({ timelineOccurrenceSourceBinding: false }) as never }).sourceBindingAvailable, false);
  assert.equal(createFinalCutNativeTargetResolver({ ...native, capabilities: () => { throw new Error("provider unavailable"); } }).sourceBindingAvailable, false);
});

test("loss of source binding during preparation prevents canonical dispatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-source-capability-drift-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const calls: string[] = [];
  let sourceAvailable = true;
  const resolveTarget = Object.assign(async () => { sourceAvailable = false; }, {});
  Object.defineProperty(resolveTarget, "sourceBindingAvailable", { get: () => sourceAvailable });
  const provider = providerFor([snapshot("Original"), snapshot("Original"), snapshot("Renamed")], calls, resolveTarget, liveState(), undefined, {}, guard);
  try {
    const before = await provider.readProject();
    await assert.rejects(provider.apply({ type: "rename-clip", clipId: "final-cut:occurrence:clip-1", name: "Renamed" }, before.revision), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED.*source/i);
    assert.deepEqual(calls, []);
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("independently bound source evidence permits a canonical edit in a deterministic provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-source-capable-provider-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const calls: string[] = [];
  const occurrence = { handle: "occurrence-handle", mediaHandle: "media-handle", name: "Original", identity: "native-1", sourceIdentity: "browser-source-1", start: "0/24", duration: "96/24", sequenceId: "final-cut:sequence:sequence-1" };
  const native = {
    capabilities: () => ({ timelineOccurrenceSourceBinding: true }) as never,
    searchMedia: async () => [{ handle: "media-handle", name: "clip.mov", sourceIdentity: "browser-source-1", source: "/tmp/clip.mov" }],
    locateOccurrence: async () => ({ status: "unique" as const, occurrences: [occurrence] }),
    locateOccurrenceForCanonicalTarget: async () => ({ status: "unique" as const, occurrences: [occurrence] }),
    selectOccurrence: async () => ({ target: { kind: "selected-clip", identity: "native-1" } }) as never,
    inspectSelectedOccurrenceSource: async () => ({ identity: "native-1", source: "/tmp/clip.mov", sourceStartTime: { value: "0", timescale: "1" }, durationTime: { value: "4", timescale: "1" } }),
  };
  const resolver = createFinalCutNativeTargetResolver(native);
  const snapshots = [snapshot("Original"), snapshot("Original"), snapshot("Renamed")];
  for (const item of snapshots) item.timeline.clips[0]!.sourceStartTime = { value: "0", timescale: "1" };
  const provider = providerFor(snapshots, calls, resolver, liveState(), undefined, {}, guard);
  try {
    const before = await provider.readProject();
    await provider.apply({ type: "rename-clip", clipId: before.timeline.clips[0]!.id, name: "Renamed" }, before.revision);
    assert.deepEqual(calls, ["edit"]);
    await guard.assertClear();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("source-bound edits reject resolvers without an explicit capability", async () => {
  for (const capability of ["missing", "throws"] as const) {
    const calls: string[] = [];
    const resolver = async () => { calls.push("resolve"); };
    if (capability === "throws") Object.defineProperty(resolver, "sourceBindingAvailable", { get: () => { throw new Error("provider unavailable"); } });
    const provider = providerFor([snapshot("Original"), snapshot("Original")], calls, resolver);
    const before = await provider.readProject();
    await assert.rejects(provider.apply({ type: "rename-clip", clipId: before.timeline.clips[0]!.id, name: "Renamed" }, before.revision), /CAPABILITY_UNAVAILABLE.*source/i, capability);
    assert.deepEqual(calls, [], capability);
  }
});

test("canonical resolver binds the observed Browser source to the snapshot source", async () => {
  for (const source of [undefined, "/other/clip.mov", "/tmp/../tmp/clip.mov", "file:///tmp/%2e%2e/tmp/clip.mov", "file:///tmp/clip.mov?variant=1", "clip.mov", "file://remote/tmp/clip.mov", "file:///tmp/clip.mov"] as const) {
    let locateCalls = 0;
    const native = {
      searchMedia: async () => [{ handle: "media-handle", name: "clip.mov", sourceIdentity: "browser-source-1", ...(source ? { source } : {}) }],
      locateOccurrence: async () => {
        locateCalls += 1;
        return { status: "unique" as const, occurrences: [{ handle: "occurrence-handle", mediaHandle: "media-handle", name: "Original", identity: "native-1", sourceIdentity: "browser-source-1", start: "0/24", duration: "96/24", sequenceId: "final-cut:sequence:sequence-1" }] };
      },
      selectOccurrence: async () => ({ target: { kind: "selected-clip", identity: "native-1" } }) as never,
    };
    const project = snapshot("Original");
    const resolve = () => createFinalCutNativeTargetResolver(native)(project.timeline.clips[0]!, project);
    if (source === "file:///tmp/clip.mov") {
      await resolve();
      assert.equal(locateCalls, 1);
    } else {
      await assert.rejects(resolve(), /TARGET_MISMATCH.*source/i);
      assert.equal(locateCalls, 0);
    }
  }
});

test("a same-named different source cannot dispatch a canonical edit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-canonical-source-mismatch-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "pending.json"));
  const calls: string[] = [];
  const native = {
    capabilities: () => ({ timelineOccurrenceSourceBinding: true }) as never,
    selectOccurrence: async () => { throw new Error("must not select a mismatched source"); },
    inspectSelectedOccurrenceSource: async () => { throw new Error("must not inspect a mismatched source"); },
    searchMedia: async () => [{ handle: "media-handle", name: "clip.mov", sourceIdentity: "browser-source-1", source: "/other/clip.mov" }],
    locateOccurrence: async () => { throw new Error("must not locate a mismatched source"); },
    locateOccurrenceForCanonicalTarget: async () => { throw new Error("must not locate a mismatched source"); },
  };
  const provider = providerFor([snapshot("Original"), snapshot("Original")], calls, createFinalCutNativeTargetResolver(native), liveState(), undefined, {}, guard);
  try {
    const before = await provider.readProject();
    await assert.rejects(provider.apply({ type: "rename-clip", clipId: before.timeline.clips[0]!.id, name: "Renamed" }, before.revision), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED.*source/i);
    assert.deepEqual(calls, []);
    await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("canonical resolver distinguishes equal names only with complete exact source observations", async () => {
  for (const alternate of ["/other/clip.mov", undefined, "/tmp/clip.mov"] as const) {
    const locatedHandles: string[] = [];
    const native = {
      searchMedia: async () => [
        { handle: "expected", name: "clip.mov", sourceIdentity: "source-1", source: "/tmp/clip.mov" },
        { handle: "alternate", name: "clip.mov", sourceIdentity: "source-2", ...(alternate ? { source: alternate } : {}) },
      ],
      locateOccurrence: async (handle: string) => {
        locatedHandles.push(handle);
        return { status: "unique" as const, occurrences: [{ handle: "occurrence", mediaHandle: handle, name: "Original", identity: "native-1", sourceIdentity: "source-1", start: "0/24", duration: "96/24", sequenceId: "final-cut:sequence:sequence-1" }] };
      },
      selectOccurrence: async () => ({ target: { kind: "selected-clip", identity: "native-1" } }) as never,
    };
    const project = snapshot("Original");
    const resolve = () => createFinalCutNativeTargetResolver(native)(project.timeline.clips[0]!, project);
    if (alternate === "/other/clip.mov") {
      await resolve();
      assert.deepEqual(locatedHandles, ["expected"]);
    } else {
      await assert.rejects(resolve(), /TARGET_MISMATCH|AMBIGUOUS_PROJECT_TARGET/);
      assert.deepEqual(locatedHandles, []);
    }
  }
});

test("MCP canonical preview tokens fail closed after expiry, reuse, or external drift", async () => {
  let now = 1_000;
  let currentSnapshot = snapshot("Original");
  const active = liveState();
  const calls: string[] = [];
  const provider = new FinalCutCanonicalNativeProvider({
    live: {
      ...liveWithoutBackgroundCatalog(),
      readLiveState: async () => structuredClone(active),
      getCapabilities: async () => ({ editor: { projectSelection: true, projectSelectionMode: "headed-only" } }) as never,
      selectProject: async () => { throw new Error("selection is not needed in this test"); },
    },
    native: {
      renameSelectedClip: async () => { calls.push("edit"); return { operationId: "edit", undoAvailable: true }; },
      undo: async () => { calls.push("undo"); return { undone: true, verification: { verified: true } }; },
    },
    readSnapshot: async () => structuredClone(currentSnapshot),
    resolveTarget: Object.assign(async () => {}, { sourceBindingAvailable: true }),
    backgroundCatalog: { listProjects: async () => ({ projects: [{ id: active.project!.id, name: active.project!.name, sequences: [{ id: active.sequence!.id, name: active.sequence!.name }] }], activeProjectId: active.project!.id, activeSequenceId: active.sequence!.id }) },
  });
  const runtime = new Runtime(new FinalCutSessionAdapter({ live: provider }), { now: () => now, previewTtlMs: 10 });
  const server = createMcpServer(runtime, { processMode: "headed" });
  const client = new Client({ name: "canonical-preview-token-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const before = await runtime.inspectProject();
    const operation = { type: "rename-clip", clipId: before.timeline.clips[0]!.id, name: "Renamed" };
    const preview = async () => {
      const result = await client.callTool({ name: "editor.timeline.edit.preview", arguments: { projectId: before.projectId, sequenceId: before.timeline.id, baseRevision: before.revision, operations: [operation], path: "headed" } });
      assert.equal(result.isError ?? false, false, textFrom(result));
      return JSON.parse(textFrom(result)).previewToken as string;
    };
    const wrongTarget = await client.callTool({ name: "editor.timeline.edit.preview", arguments: { projectId: "wrong-project", sequenceId: before.timeline.id, baseRevision: before.revision, operations: [operation], path: "headed" } });
    assert.equal(wrongTarget.isError, true);
    assert.match(textFrom(wrongTarget), /TARGET_MISMATCH/);
    const expired = await preview();
    now += 11;
    const expiredResult = await client.callTool({ name: "editor.timeline.edit.execute", arguments: { previewToken: expired, path: "headed" } });
    assert.equal(expiredResult.isError, true);
    assert.match(textFrom(expiredResult), /PREVIEW_TOKEN_EXPIRED/);
    const reusedResult = await client.callTool({ name: "editor.timeline.edit.execute", arguments: { previewToken: expired, path: "headed" } });
    assert.equal(reusedResult.isError, true);
    assert.match(textFrom(reusedResult), /PREVIEW_TOKEN_INVALID/);
    const stale = await preview();
    currentSnapshot = snapshot("External change");
    const staleResult = await client.callTool({ name: "editor.timeline.edit.execute", arguments: { previewToken: stale, path: "headed" } });
    assert.equal(staleResult.isError, true);
    assert.match(textFrom(staleResult), /STALE_CONTEXT/);
    const staleReuse = await client.callTool({ name: "editor.timeline.edit.execute", arguments: { previewToken: stale, path: "headed" } });
    assert.equal(staleReuse.isError, true);
    assert.match(textFrom(staleReuse), /PREVIEW_TOKEN_INVALID/);
    assert.equal((await runtime.inspectProject()).timeline.clips[0]?.name, "External change");
    assert.deepEqual(calls, []);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP canonical rename previews, verifies, and undoes against the bound target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-canonical-mcp-loop-"));
  const guard = new FileCanonicalRecoveryGuard(join(directory, "recovery.json"));
  const active = liveState();
  let current = snapshot("Original");
  const calls: string[] = [];
  const provider = new FinalCutCanonicalNativeProvider({
    live: {
      ...liveWithoutBackgroundCatalog(),
      readLiveState: async () => structuredClone(active),
      getCapabilities: async () => ({ editor: { projectSelection: true, projectSelectionMode: "headed-only" } }) as never,
      selectProject: async () => { throw new Error("selection is not needed in this test"); },
    },
    native: {
      renameSelectedClip: async (name) => { calls.push("edit"); current.timeline.clips[0]!.name = name; return { operationId: "native-1", undoAvailable: true }; },
      undo: async () => { calls.push("undo"); current = snapshot("Original"); return { undone: true, verification: { verified: true } }; },
    },
    readSnapshot: async () => structuredClone(current),
    resolveTarget: Object.assign(async () => {}, { sourceBindingAvailable: true }),
    backgroundCatalog: { listProjects: async () => ({ projects: [{ id: active.project!.id, name: active.project!.name, sequences: [{ id: active.sequence!.id, name: active.sequence!.name }] }], activeProjectId: active.project!.id, activeSequenceId: active.sequence!.id }) },
    recoveryGuard: guard,
  });
  const runtime = new Runtime(new FinalCutSessionAdapter({ live: provider }));
  const server = createMcpServer(runtime, { processMode: "headed", canonicalRecovery: guard });
  const client = new Client({ name: "canonical-mcp-loop", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const call = async (name: string, arguments_: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: arguments_ });
    assert.equal(response.isError ?? false, false, `${name}: ${textFrom(response)}`);
    return JSON.parse(textFrom(response));
  };
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const target = { projectId: active.project!.id, sequenceId: active.sequence!.id };
    const inspect = () => call("project.inspect", { confirmHeadedRead: true, expectedTarget: target });
    const before = await inspect();
    const beforeDigest = canonicalSnapshotDigest(before);
    const operation = { type: "rename-clip", clipId: before.timeline.clips[0].id, name: "Renamed" };
    const preview = await call("editor.timeline.edit.preview", { ...target, baseRevision: before.revision, operations: [operation], path: "headed" });
    const afterPreview = await inspect();
    assert.equal(canonicalSnapshotDigest(afterPreview), beforeDigest);
    assert.equal(afterPreview.revision.id, before.revision.id);
    assert.deepEqual(calls, []);
    const edited = await call("editor.timeline.edit.execute", { previewToken: preview.previewToken, path: "headed" });
    assert.equal(edited.status, "VERIFIED");
    assert.equal(edited.diff.modified.length, 1);
    assert.equal(edited.diff.modified[0].itemId, operation.clipId);
    assert.equal(edited.after.timeline.clips[0].name, "Renamed");
    assert.ok(edited.after.revision.sequence > before.revision.sequence);
    const restored = await call("edit.undo", { transactionId: edited.id });
    assert.equal(canonicalSnapshotDigest(restored), beforeDigest);
    assert.ok(restored.revision.sequence > edited.after.revision.sequence);
    assert.deepEqual(calls, ["edit", "undo"]);
    await guard.assertClear();
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP canonical verification failure restores or retains recovery checkpoint", async () => {
  for (const undoFails of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), "framekit-canonical-mcp-rollback-"));
    const guard = new FileCanonicalRecoveryGuard(join(directory, "recovery.json"));
    const active = liveState();
    let current = snapshot("Original");
    const calls: string[] = [];
    const provider = new FinalCutCanonicalNativeProvider({
      live: {
        ...liveWithoutBackgroundCatalog(),
        readLiveState: async () => structuredClone(active),
        getCapabilities: async () => ({ editor: { projectSelection: true, projectSelectionMode: "headed-only" } }) as never,
        selectProject: async () => { throw new Error("selection is not needed in this test"); },
      },
      native: {
        renameSelectedClip: async (name) => { calls.push("edit"); current.timeline.clips[0]!.name = name; return { operationId: "native-1", undoAvailable: true }; },
        undo: async () => { calls.push("undo"); if (undoFails) throw new Error("simulated Undo failure"); current = snapshot("Original"); return { undone: true, verification: { verified: true } }; },
      },
      readSnapshot: async () => structuredClone(current),
      resolveTarget: Object.assign(async () => {}, { sourceBindingAvailable: true }),
      backgroundCatalog: { listProjects: async () => ({ projects: [{ id: active.project!.id, name: active.project!.name, sequences: [{ id: active.sequence!.id, name: active.sequence!.name }] }], activeProjectId: active.project!.id, activeSequenceId: active.sequence!.id }) },
      recoveryGuard: guard,
    });
    const runtime = new Runtime(new FinalCutSessionAdapter({ live: provider }), {
      verificationEngine: { verify: async () => ({ passed: false, checks: [{ name: "fixture-failure", passed: false, detail: "simulated verification failure" }] }) },
    });
    const server = createMcpServer(runtime, { processMode: "headed", canonicalRecovery: guard });
    const client = new Client({ name: "canonical-mcp-rollback", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const before = await runtime.inspectProject();
      const operation = { type: "rename-clip", clipId: before.timeline.clips[0]!.id, name: "Renamed" };
      const preview = await client.callTool({ name: "editor.timeline.edit.preview", arguments: { projectId: before.projectId, sequenceId: before.timeline.id, baseRevision: before.revision, operations: [operation], path: "headed" } });
      assert.equal(preview.isError ?? false, false, textFrom(preview));
      const executed = await client.callTool({ name: "editor.timeline.edit.execute", arguments: { previewToken: JSON.parse(textFrom(preview)).previewToken, path: "headed" } });
      assert.deepEqual(calls, ["edit", "undo"]);
      if (undoFails) {
        assert.equal(executed.isError, true);
        assert.match(textFrom(executed), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
        await assert.rejects(guard.assertClear(), /FINAL_CUT_CANONICAL_RECOVERY_REQUIRED/);
        assert.equal(current.timeline.clips[0]!.name, "Renamed");
      } else {
        assert.equal(executed.isError ?? false, false, textFrom(executed));
        assert.equal(JSON.parse(textFrom(executed)).status, "ROLLED_BACK");
        assert.equal(canonicalSnapshotDigest(await runtime.inspectProject()), canonicalSnapshotDigest(before));
        await guard.assertClear();
      }
    } finally {
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("MCP canonical operations verify exact semantics and restore after failures", async () => {
  const trimBefore = snapshot("Original");
  const trimAfter = structuredClone(trimBefore);
  trimAfter.timeline.duration = 3;
  trimAfter.timeline.durationTime = { value: "72", timescale: "24" };
  trimAfter.timeline.clips[0] = { ...trimAfter.timeline.clips[0]!, duration: 3, durationTime: { value: "72", timescale: "24" } };
  trimAfter.timeline.storyElements[0] = { ...trimAfter.timeline.storyElements[0]!, duration: 3, durationTime: { value: "72", timescale: "24" } };
  const marker = markerSnapshots();
  marker.after.timeline.markers[0]!.id = "native-marker-id";
  const ripple = rippleSnapshots();
  const gain = gainSnapshots();
  const cases = [
    { label: "trim-clip", before: trimBefore, after: trimAfter, operation: { type: "trim-clip", clipId: trimBefore.timeline.clips[0]!.id, duration: 3, durationTime: { value: "72", timescale: "24" } } },
    { label: "add-marker", before: marker.before, after: marker.after, operation: { type: "add-marker", timelineId: marker.before.timeline.id, marker: { ...marker.after.timeline.markers[0], id: "requested-marker-id" } } },
    { label: "ripple-delete", before: ripple.before, after: ripple.after, operation: { type: "ripple-delete", timelineId: ripple.before.timeline.id, range: { start: 2, end: 4, startTime: { value: "48", timescale: "24" }, durationTime: { value: "48", timescale: "24" } }, candidateId: "filler-1", reason: "remove verified filler" } },
    { label: "set-gain", before: gain.before, after: gain.after, operation: { type: "set-gain", clipId: gain.before.timeline.clips[0]!.id, gainDb: 3 } },
  ];
  for (const scenario of cases) for (const verificationFails of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), "framekit-canonical-mcp-matrix-"));
    const guard = new FileCanonicalRecoveryGuard(join(directory, "recovery.json"));
    const active = liveState();
    let current = structuredClone(scenario.before);
    const calls: string[] = [];
    const mutate = async () => { calls.push(scenario.label); current = structuredClone(scenario.after); return { operationId: "native-1", undoAvailable: true }; };
    const provider = new FinalCutCanonicalNativeProvider({
      live: { ...liveWithoutBackgroundCatalog(), readLiveState: async () => structuredClone(active), getCapabilities: async () => ({ editor: { projectSelection: true, projectSelectionMode: "headed-only" } }) as never, selectProject: async () => { throw new Error("selection is not needed in this test"); } },
      native: { renameSelectedClip: mutate, trimSelectedClipToRange: mutate, addMarkerAtTime: mutate, rippleDeleteRange: mutate, setSelectedClipGain: mutate, undo: async () => { calls.push("undo"); current = structuredClone(scenario.before); return { undone: true, verification: { verified: true } }; } },
      readSnapshot: async () => structuredClone(current),
      resolveTarget: Object.assign(async () => {}, { sourceBindingAvailable: true }),
      backgroundCatalog: { listProjects: async () => ({ projects: [{ id: active.project!.id, name: active.project!.name, sequences: [{ id: active.sequence!.id, name: active.sequence!.name }] }], activeProjectId: active.project!.id, activeSequenceId: active.sequence!.id }) },
      recoveryGuard: guard,
    });
    const runtime = new Runtime(new FinalCutSessionAdapter({ live: provider }), verificationFails ? { verificationEngine: { verify: async () => ({ passed: false, checks: [{ name: "fixture-failure", passed: false, detail: "simulated verification failure" }] }) } } : {});
    const server = createMcpServer(runtime, { processMode: "headed", canonicalRecovery: guard });
    const client = new Client({ name: "canonical-mcp-matrix", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const call = async (name: string, arguments_: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: arguments_ });
      assert.equal(response.isError ?? false, false, `${scenario.label} ${name}: ${textFrom(response)}`);
      return JSON.parse(textFrom(response));
    };
    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const before = await runtime.inspectProject();
      const capabilities = await call("editor.inspect", {});
      assert.equal(capabilities.capabilities.editor.semanticOperations[scenario.label], true, scenario.label);
      if (scenario.label === "add-marker") assert.equal(capabilities.capabilities.editor.markerIdentityMode, "editor-assigned");
      const beforeDigest = canonicalSnapshotDigest(before);
      const preview = await call("editor.timeline.edit.preview", { projectId: before.projectId, sequenceId: before.timeline.id, baseRevision: before.revision, operations: [scenario.operation], path: "headed" });
      assert.equal(canonicalSnapshotDigest(await runtime.inspectProject()), beforeDigest, scenario.label);
      assert.deepEqual(calls, []);
      const transaction = await call("editor.timeline.edit.execute", { previewToken: preview.previewToken, path: "headed" });
      assert.equal(transaction.status, verificationFails ? "ROLLED_BACK" : "VERIFIED", `${scenario.label}: ${JSON.stringify(transaction.verification)}`);
      assert.equal(canonicalSnapshotDigest(transaction.attemptedAfter), canonicalSnapshotDigest(scenario.after), scenario.label);
      if (!verificationFails) {
        assert.ok(transaction.after.revision.sequence > before.revision.sequence, scenario.label);
        await call("edit.undo", { transactionId: transaction.id });
      }
      assert.equal(canonicalSnapshotDigest(await runtime.inspectProject()), beforeDigest, scenario.label);
      assert.deepEqual(calls, [scenario.label, "undo"]);
      await guard.assertClear();
    } finally {
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});
