import assert from "node:assert/strict";
import test from "node:test";
import {
  DisposableNativeEditWorkflow,
  type NativeFinalCutCapabilities,
  type NativeFinalCutContext,
  type NativeFinalCutEditor,
  type NativeFinalCutEdit,
  type NativeFinalCutEditResult,
  type NativeFinalCutUndoResult,
} from "@framekit/final-cut";
import type { ProjectSnapshot, RuntimeCapabilities } from "@framekit/runtime";

const canonicalCapabilities: RuntimeCapabilities = {
  editor: {
    canonicalTimelineMode: "canonical-write",
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
    projectSelection: true,
  },
  analyzers: {
    speechTranscribe: false,
    speechVad: false,
    audioLoudness: false,
    visualTrack: false,
  },
};

const nativeCapabilities: NativeFinalCutCapabilities = {
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
  timelineFocus: true,
  requiresAccessibility: true,
  requiresFinalCutFrontmost: true,
};

test("disposable native preview binds the canonical target without mutating it", async () => {
  const state = createState();
  const workflow = createWorkflow(state);

  const preview = await workflow.preview({ clipId: "clip-1", name: "Interview Clean" });

  assert.match(preview.previewToken, /^disposable-native-preview-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(preview.operation.type, "rename-selected-clip");
  assert.equal(preview.target.clipId, "clip-1");
  assert.equal(preview.target.name, "Interview");
  assert.deepEqual(preview.baseRevision, state.snapshot.revision);
  assert.equal(state.nativeEditCalls, 0);
  assert.equal(state.snapshot.timeline.clips[0]?.name, "Interview");
});

test("disposable native execute returns a canonical diff and explicit undo restores the digest", async () => {
  const state = createState();
  const workflow = createWorkflow(state);
  const preview = await workflow.preview({ clipId: "clip-1", name: "Interview Clean" });

  const result = await workflow.execute(preview.previewToken);

  assert.equal(result.status, "VERIFIED");
  assert.equal(result.verification.passed, true);
  assert.equal(result.diff.modified[0]?.itemId, "clip-1");
  assert.equal(result.before.timeline.clips[0]?.name, "Interview");
  assert.equal(result.after.timeline.clips[0]?.name, "Interview Clean");
  assert.equal(state.nativeEditCalls, 1);

  const undone = await workflow.undo(result.operationId);

  assert.equal(undone.undone, true);
  assert.equal(undone.beforeDigest, undone.restoredDigest);
  assert.equal(undone.restored.timeline.clips[0]?.name, "Interview");
  assert.equal(state.nativeUndoCalls, 1);
});

test("disposable native restoration evidence names the requested non-first target", async () => {
  const state = createState();
  state.snapshot.timeline.clips.push({
    id: "clip-2",
    mediaId: "media-2",
    name: "Outro",
    start: 10,
    duration: 5,
    track: 1,
    startTime: { value: "10", timescale: "1" },
    durationTime: { value: "5", timescale: "1" },
  });
  state.targetClipId = "clip-2";
  state.selectedName = "Outro";
  const workflow = createWorkflow(state);
  const preview = await workflow.preview({ clipId: "clip-2", name: "Outro Clean" });

  const result = await workflow.execute(preview.previewToken);
  const undone = await workflow.undo(result.operationId);
  const targetCheck = undone.verification.checks.find((check) => check.name === "canonical-target-restored");

  assert.match(targetCheck?.detail ?? "", /clip-2/);
});

test("disposable native execute rejects a stale preview before native mutation", async () => {
  const state = createState();
  const workflow = createWorkflow(state);
  const preview = await workflow.preview({ clipId: "clip-1", name: "Interview Clean" });
  state.snapshot = withRevision(state.snapshot, 2);

  await assert.rejects(workflow.execute(preview.previewToken), /STALE_CONTEXT/);
  assert.equal(state.nativeEditCalls, 0);
});

test("disposable native execute rejects changed native targets before mutation", async () => {
  const state = createState();
  const workflow = createWorkflow(state);
  const preview = await workflow.preview({ clipId: "clip-1", name: "Interview Clean" });
  state.selectedName = "Other clip";

  await assert.rejects(workflow.execute(preview.previewToken), /TARGET_MISMATCH/);
  assert.equal(state.nativeEditCalls, 0);
});

test("disposable native verification failure compensates with native Undo", async () => {
  const state = createState();
  const workflow = createWorkflow(state);
  const preview = await workflow.preview({ clipId: "clip-1", name: "Interview Clean" });
  state.canonicalAfterEditName = "Unexpected result";

  const result = await workflow.execute(preview.previewToken);

  assert.equal(result.status, "ROLLED_BACK");
  assert.equal(result.verification.passed, false);
  assert.equal(result.restored?.timeline.clips[0]?.name, "Interview");
  assert.equal(result.restoredDigest, result.beforeDigest);
  assert.equal(state.nativeUndoCalls, 1);
});

test("disposable native workflow fails closed when canonical snapshots are unavailable", async () => {
  const state = createState();
  const workflow = new DisposableNativeEditWorkflow({
    native: state.native,
    readCanonicalSnapshot: async () => {
      throw new Error("CAPABILITY_UNAVAILABLE: live Final Cut canonical snapshot");
    },
    readCanonicalCapabilities: async () => ({
      ...canonicalCapabilities,
      editor: { ...canonicalCapabilities.editor, canonicalTimelineMode: "metadata-only" },
    }),
  });

  await assert.rejects(
    workflow.preview({ clipId: "clip-1", name: "Interview Clean" }),
    /CAPABILITY_UNAVAILABLE: disposable native canonical snapshot/,
  );
  assert.equal(state.nativeEditCalls, 0);
});

interface TestState {
  snapshot: ProjectSnapshot;
  targetClipId: string;
  selectedName: string;
  canonicalAfterEditName?: string;
  nativeEditCalls: number;
  nativeUndoCalls: number;
  native: NativeFinalCutEditor;
}

function createWorkflow(state: TestState): DisposableNativeEditWorkflow {
  return new DisposableNativeEditWorkflow({
    native: state.native,
    readCanonicalSnapshot: async () => {
      const snapshot = structuredClone(state.snapshot);
      if (state.nativeEditCalls > state.nativeUndoCalls) {
        const target = snapshot.timeline.clips.find((clip) => clip.id === state.targetClipId);
        target!.name = state.canonicalAfterEditName ?? state.selectedName;
        snapshot.revision = { id: "rev-2", sequence: 2, timestamp: new Date(2).toISOString() };
      }
      return snapshot;
    },
    readCanonicalCapabilities: async () => canonicalCapabilities,
  });
}

function createState(): TestState {
  const state = {} as TestState;
  state.snapshot = snapshot("Interview", 1);
  state.targetClipId = "clip-1";
  state.selectedName = "Interview";
  state.nativeEditCalls = 0;
  state.nativeUndoCalls = 0;
  state.native = {
    capabilities: () => nativeCapabilities,
    inspect: async () => nativeContext(state.selectedName, state.nativeEditCalls > 0),
    focusTimeline: async () => nativeContext(state.selectedName, state.nativeEditCalls > 0),
    edit: async (operation: Extract<NativeFinalCutEdit, { type: "rename-selected-clip" }>) => {
      state.nativeEditCalls += 1;
      state.selectedName = operation.name;
      return nativeEditResult(operation, state.selectedName);
    },
    undo: async (operationId: string) => {
      state.nativeUndoCalls += 1;
      state.selectedName = "Interview";
      return nativeUndoResult(operationId, state.selectedName);
    },
  } as unknown as NativeFinalCutEditor;
  return state;
}

function snapshot(name: string, revision: number): ProjectSnapshot {
  return {
    projectId: "project-1",
    projectName: "Disposable Native",
    timeline: {
      id: "timeline-1",
      name: "Main",
      duration: 10,
      durationTime: { value: "10", timescale: "1" },
      clips: [{
        id: "clip-1",
        mediaId: "media-1",
        name,
        start: 0,
        duration: 10,
        track: 1,
        startTime: { value: "0", timescale: "1" },
        durationTime: { value: "10", timescale: "1" },
      }],
      storyElements: [{ id: "clip-1", kind: "asset-clip", start: 0, duration: 10, lane: 1, mediaId: "media-1" }],
      markers: [],
      captions: [],
    },
    media: [{ mediaId: "media-1", source: "interview.mov" }],
    revision: { id: `rev-${revision}`, sequence: revision, timestamp: new Date(revision).toISOString() },
  };
}

function withRevision(value: ProjectSnapshot, revision: number): ProjectSnapshot {
  return { ...structuredClone(value), revision: { id: `rev-${revision}`, sequence: revision, timestamp: new Date(revision).toISOString() } };
}

function nativeContext(name: string, edited: boolean): NativeFinalCutContext {
  return {
    available: true,
    application: "Final Cut Pro",
    frontmost: true,
    frontWindow: "Final Cut Pro",
    timelineWindowAvailable: true,
    timelineFocused: true,
    focusTarget: "timeline",
    project: "Disposable Native",
    sequence: "Main",
    target: { kind: "selected-clip", name, identity: "native-target-1" },
    bladeAvailable: false,
    undoAvailable: edited,
    ...(edited ? { undoCommand: "Undo Apply Custom Name" } : {}),
  };
}

function nativeEditResult(
  operation: Parameters<NativeFinalCutEditor["edit"]>[0],
  name: string,
): NativeFinalCutEditResult {
  return {
    operationId: "native-operation-1",
    operation,
    command: "Modify > Apply Custom Name",
    before: nativeContext("Interview", false),
    after: nativeContext(name, true),
    verification: { verified: true, level: "selection-observed", detail: "Selected clip name changed" },
    undoAvailable: true,
    undoCommand: "Undo Apply Custom Name",
  };
}

function nativeUndoResult(operationId: string, name: string): NativeFinalCutUndoResult {
  return {
    operationId,
    undone: true,
    context: nativeContext(name, false),
    verification: { verified: true, detail: "Final Cut restored the native edit's pre-operation state" },
  };
}
