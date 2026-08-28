import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { sanitizeDisposableNativeEvidence } from "../../scripts/final-cut-evidence.mjs";

test("disposable native headed runner publishes the sanitized evidence contract", async () => {
  const runner = await readFile(join(process.cwd(), "scripts/final-cut-disposable-native-headed-e2e.mjs"), "utf8");

  assert.match(runner, /editor\.native\.disposable\.preview/);
  assert.match(runner, /editor\.native\.disposable\.execute/);
  assert.match(runner, /editor\.native\.disposable\.undo/);
  assert.match(runner, /sanitizeDisposableNativeEvidence/);
  assert.match(runner, /FRAMEKIT_FINAL_CUT_NATIVE_WRITES/);
  assert.match(runner, /JSON\.stringify\(evidence, null, 2\)/);
});

test("disposable native evidence preserves proof while omitting raw native state", () => {
  const evidence = sanitizeDisposableNativeEvidence(rawRun, environment);

  assert.equal(evidence.evidenceType, "headed-native-disposable-mutation");
  assert.equal(evidence.mutation.operation, "rename-selected-clip");
  assert.equal(evidence.mutation.status, "VERIFIED");
  assert.equal(evidence.restoration.restored, true);
  assert.deepEqual(evidence.toolResults, [
    { name: "editor.inspect", status: "passed" },
    { name: "project.inspect", status: "passed" },
    { name: "editor.native.disposable.preview", status: "passed" },
    { name: "editor.native.disposable.execute", status: "VERIFIED" },
    { name: "editor.native.disposable.undo", status: "passed" },
  ]);

  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes("/Users/private/secret-footage.mov"), false);
  assert.equal(serialized.includes("do not publish this credential"), false);
  assert.equal(serialized.includes("native operation secret"), false);
});

test("disposable native evidence rejects metadata-only capability claims", () => {
  const metadataOnlyRun = structuredClone(rawRun);
  metadataOnlyRun.capabilities.editor.canonicalTimelineMode = "metadata-only";

  assert.throws(
    () => sanitizeDisposableNativeEvidence(metadataOnlyRun, environment),
    /FINAL_CUT_E2E_EVIDENCE_INCOMPLETE: canonical live capability is required/,
  );
});

test("disposable native evidence rejects unidentifiable extra modified entries", () => {
  const malformedRun = structuredClone(rawRun);
  Reflect.set(malformedRun.diff, "modified", [...malformedRun.diff.modified, { detail: "unidentifiable change" }]);

  assert.throws(
    () => sanitizeDisposableNativeEvidence(malformedRun, environment),
    /FINAL_CUT_E2E_EVIDENCE_INCOMPLETE: disposable diff does not identify exactly the target occurrence/,
  );
});

const environment = {
  framekitVersion: "0.1.0",
  finalCutVersion: "10.7.1",
  gitCommit: "0123456789abcdef0123456789abcdef01234567",
  nodeVersion: "v22.15.0",
  platform: "darwin",
  architecture: "arm64",
  osVersion: "Darwin Kernel Version 25.5.0",
};

const rawRun = {
  passed: true,
  recordedAt: "2026-08-28T10:00:00.000Z",
  editor: { name: "Final Cut Pro", version: "10.7.1", backend: "workflow-extension-ipc" },
  capabilities: {
    editor: {
      canonicalTimelineMode: "canonical-read",
      projectRead: true,
      timelineSnapshotRead: true,
      readAfterWrite: true,
      projectCatalogRead: true,
      projectSelection: true,
      secret: "do not publish this credential",
    },
    analyzers: {},
  },
  nativeCapabilities: {
    selectionEdit: true,
    undo: true,
    timelineFocus: true,
    requiresAccessibility: true,
    requiresFinalCutFrontmost: true,
    privateDiagnostic: "native operation secret",
  },
  project: { id: "project-1", name: "Disposable E2E", sequenceId: "timeline-1" },
  target: { occurrenceId: "clip-1", mediaId: "media-1" },
  toolResults: [
    { name: "editor.inspect", status: "passed" },
    { name: "project.inspect", status: "passed" },
    { name: "editor.native.disposable.preview", status: "passed" },
    { name: "editor.native.disposable.execute", status: "VERIFIED" },
    { name: "editor.native.disposable.undo", status: "passed" },
  ],
  executeStatus: "VERIFIED",
  before: snapshot("Interview", 10),
  after: snapshot("Interview [Framekit Disposable E2E]", 11),
  restored: snapshot("Interview", 12),
  diff: {
    added: [],
    removed: [],
    modified: [{ itemId: "clip-1" }],
    durationDelta: 0,
    affectedRanges: [],
  },
  digests: { before: "before-digest", after: "after-digest", restored: "before-digest" },
  restoredVerification: { passed: true },
};

function snapshot(name: string, sequence: number) {
  return {
    projectId: "project-1",
    projectName: "Disposable E2E",
    timeline: {
      id: "timeline-1",
      name: "Main",
      duration: 10,
      clips: [{ id: "clip-1", mediaId: "media-1", name, start: 0, duration: 10, track: 1 }],
    },
    media: [{ mediaId: "media-1", source: "/Users/private/secret-footage.mov" }],
    revision: { id: `rev-${sequence}`, sequence, timestamp: `2026-08-28T10:00:${String(sequence).padStart(2, "0")}.000Z` },
  };
}
