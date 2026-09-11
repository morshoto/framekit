import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, writeFile } from "node:fs/promises";
import {
  buildFinalCutCanonicalExportScript,
  createFinalCutNativeTargetResolver,
  FinalCutCanonicalSnapshotSource,
  FinalCutCanonicalNativeProvider,
  type CanonicalNativeTargetResolver,
} from "@framekit/final-cut";
import type {
  ContextRevision,
  EditorChange,
  EditorIdentity,
  EditorLiveState,
  ProjectSnapshot,
} from "@framekit/runtime";

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

function liveState(): EditorLiveState {
  return {
    project: { id: "active-project", name: "Canonical E2E" },
    sequence: {
      id: "active-sequence",
      name: "Canonical E2E",
      startTime: { value: "0", timescale: "24" },
      duration: { value: "96", timescale: "24" },
      frameDuration: { value: "1", timescale: "24" },
    },
    revision: { id: "live-revision", sequence: 1, timestamp: new Date(1).toISOString() },
  };
}

function providerFor(
  snapshots: Array<ProjectSnapshot | Error>,
  calls: string[],
  resolveTarget: CanonicalNativeTargetResolver = async () => {},
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
  };
  const live = {
    getIdentity: async () => identity,
    readLiveState: async () => liveState(),
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
  });
}

test("canonical native provider exposes one explicit active project and sequence", async () => {
  const provider = providerFor([snapshot("Original")], []);

  const catalog = await provider.listProjects();

  assert.equal(catalog.projects.length, 1);
  assert.equal(catalog.activeProjectId, "final-cut:project:project-1");
  assert.equal(catalog.activeSequenceId, "final-cut:sequence:sequence-1");
  assert.equal((await provider.getCapabilities()).editor.canonicalTimelineMode, "canonical-write");
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

test("canonical Final Cut export is driven by the active timeline UI", () => {
  const script = buildFinalCutCanonicalExportScript("/tmp/framekit-canonical.fcpxml");

  assert.match(script, /File/);
  assert.match(script, /Export/);
  assert.match(script, /XML/);
  assert.match(script, /framekit-canonical\.fcpxml/);
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
        start: "0/24",
        duration: "96/24",
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
