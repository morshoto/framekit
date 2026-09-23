import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeRoughCutEvidence } from "../../scripts/final-cut-evidence.mjs";

const environment = {
  framekitVersion: "0.1.7",
  finalCutVersion: "10.7.1",
  gitCommit: "a".repeat(40),
  nodeVersion: "v22.15.0",
  platform: "darwin",
  architecture: "arm64",
  osVersion: "Darwin Kernel Version 25.5.0",
};

test("rough-cut headed evidence preserves the verified workflow without private state", () => {
  const evidence = sanitizeRoughCutEvidence({
    passed: true,
    recordedAt: "2026-09-11T00:00:00.000Z",
    editor: { name: "Final Cut Pro", version: "10.7.1", backend: "workflow-extension-ipc" },
    capabilities: {
      editor: {
        canonicalTimelineMode: "metadata-only",
        projectRead: false,
        timelineSnapshotRead: false,
        timelineWrite: false,
        timelineArtifactWrite: false,
        readAfterWrite: false,
        incrementalChanges: false,
        rollback: false,
        assetDiscovery: true,
        liveStateRead: true,
        playheadWrite: false,
        frameCapture: false,
        privateDiagnostic: "/tmp/diagnostic.log",
      },
      analyzers: {},
    },
    nativeCapabilities: {
      mediaLibrarySearch: true,
      mediaImport: true,
      mediaSelection: true,
      mediaAppend: true,
      mediaInsert: true,
      titleDiscovery: true,
      titlePlacement: true,
      timelineFocus: true,
      undo: true,
      requiresAccessibility: true,
      requiresFinalCutFrontmost: true,
      privateDiagnostic: "native operation secret",
    },
    project: {
      before: { id: "project-1", name: "Disposable Rough Cut" },
      after: { id: "project-1", name: "Disposable Rough Cut" },
    },
    sequence: {
      before: { id: "sequence-1", name: "Main" },
      after: { id: "sequence-1", name: "Main" },
    },
    media: {
      resolution: { status: "passed", name: "rough-cut.mov", kind: "video", sourcePath: "/tmp/secret-source.mov" },
      imported: { status: "passed", name: "rough-cut.mov", kind: "video", mediaHandle: "private-media-handle" },
      occurrence: { id: "occurrence-rough-cut", name: "rough-cut.mov", start: "10/1", duration: "5/1" },
    },
    placement: {
      operation: "append",
      range: { start: "10/1", duration: "5/1" },
      beforeDuration: "10/1",
      afterDuration: "15/1",
      verified: true,
      operationId: "private-operation",
    },
    animation: {
      kind: "title",
      asset: {
        id: "final-cut:title:basic-title",
        name: "Basic Title",
        vendor: "Final Cut Pro",
        backend: "final-cut-accessibility",
        guarantee: "observed",
      },
      occurrenceId: "occurrence-title",
      range: { start: "0/1", duration: "3/1" },
      verified: true,
    },
    revisions: { before: "rev-1", after: "rev-2", restored: "rev-3" },
    verification: { import: true, placement: true, animation: true, undo: true },
    rollback: { status: "passed", restored: true },
    stepResults: [
      { name: "media.resolve", status: "passed" },
      { name: "media.placement.execute", status: "passed" },
    ],
    toolResults: [
      { name: "connection.status", status: "passed" },
      { name: "editor.inspect", status: "passed" },
      { name: "editor.live.inspect", status: "passed" },
      { name: "editor.native.media.import", status: "passed" },
      { name: "editor.native.media.search", status: "passed" },
      { name: "editor.native.media.select", status: "passed" },
      { name: "editor.native.media.append.preview", status: "passed" },
      { name: "editor.native.media.append.execute", status: "passed" },
      { name: "editor.native.title.add.preview", status: "passed" },
      { name: "editor.native.title.add.execute", status: "passed" },
      { name: "editor.native.undo", status: "passed" },
    ],
  }, environment);

  assert.equal(evidence.evidenceType, "headed-native-rough-cut-acceptance");
  assert.deepEqual(evidence.project, {
    before: { id: "project-1", name: "Disposable Rough Cut" },
    after: { id: "project-1", name: "Disposable Rough Cut" },
  });
  assert.deepEqual(evidence.sequence, {
    before: { id: "sequence-1", name: "Main" },
    after: { id: "sequence-1", name: "Main" },
  });
  assert.deepEqual(evidence.revisions, { before: "rev-1", after: "rev-2", restored: "rev-3" });
  assert.equal(evidence.media.occurrence.id, "occurrence-rough-cut");
  assert.deepEqual(evidence.placement.range, { start: "10/1", duration: "5/1" });
  assert.deepEqual(evidence.verification, { import: true, placement: true, animation: true, undo: true });
  assert.deepEqual(evidence.steps, [
    { name: "media.resolve", status: "passed" },
    { name: "media.placement.execute", status: "passed" },
  ]);

  const serialized = JSON.stringify(evidence);
  assert.doesNotMatch(serialized, /private-media-handle|private-operation|secret-source\.mov|native operation secret|privateDiagnostic/);
});

test("rough-cut headed evidence rejects an unverified animation", () => {
  assert.throws(
    () => sanitizeRoughCutEvidence({
      passed: true,
      recordedAt: "2026-09-11T00:00:00.000Z",
      editor: { name: "Final Cut Pro", version: "10.7.1", backend: "workflow-extension-ipc" },
      capabilities: { editor: { canonicalTimelineMode: "metadata-only" }, analyzers: {} },
      nativeCapabilities: {
        mediaLibrarySearch: true,
        mediaImport: true,
        mediaSelection: true,
        mediaAppend: true,
        mediaInsert: true,
        titleDiscovery: true,
        titlePlacement: true,
        timelineFocus: true,
        undo: true,
        requiresAccessibility: true,
        requiresFinalCutFrontmost: true,
      },
      project: { before: { id: "project-1", name: "Rough Cut" }, after: { id: "project-1", name: "Rough Cut" } },
      sequence: { before: { id: "sequence-1", name: "Main" }, after: { id: "sequence-1", name: "Main" } },
      media: {
        resolution: { status: "passed", name: "rough-cut.mov", kind: "video" },
        imported: { status: "passed", name: "rough-cut.mov", kind: "video" },
        occurrence: { id: "occurrence-1", name: "rough-cut.mov", start: "0/1", duration: "5/1" },
      },
      placement: { operation: "append", range: { start: "0/1", duration: "5/1" }, beforeDuration: "0/1", afterDuration: "5/1", verified: true },
      animation: {
        kind: "title",
        asset: { id: "final-cut:title:basic-title", name: "Basic Title", vendor: "Final Cut Pro", backend: "final-cut-accessibility", guarantee: "observed" },
        occurrenceId: "occurrence-title",
        range: { start: "0/1", duration: "3/1" },
        verified: false,
      },
      revisions: { before: "rev-1", after: "rev-2", restored: "rev-3" },
      verification: { import: true, placement: true, animation: false, undo: true },
      rollback: { status: "passed", restored: true },
      toolResults: [{ name: "connection.status", status: "passed" }],
    }, environment),
    /animation was not verified/,
  );
});
