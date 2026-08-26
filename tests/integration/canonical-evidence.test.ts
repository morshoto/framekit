import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { sanitizeCanonicalEvidence } from "../../scripts/final-cut-evidence.mjs";

test("canonical headed runner publishes the sanitized evidence contract", async () => {
  const runner = await readFile(join(process.cwd(), "scripts/final-cut-canonical-headed-e2e.mjs"), "utf8");

  assert.match(runner, /sanitizeCanonicalEvidence/);
  assert.match(runner, /gitCommit/);
  assert.match(runner, /editStatus: transaction\.status/);
  assert.match(runner, /JSON\.stringify\(evidence, null, 2\)/);
});

test("canonical headed evidence keeps mutation proof while omitting private snapshot data", () => {
  const evidence = sanitizeCanonicalEvidence(rawRun, {
    framekitVersion: "0.1.0",
    gitCommit: "0123456789abcdef0123456789abcdef01234567",
    nodeVersion: "v22.15.0",
    platform: "darwin",
    architecture: "arm64",
    osVersion: "Darwin Kernel Version 25.5.0",
  });

  assert.deepEqual(evidence, {
    schemaVersion: 1,
    evidenceType: "headed-native-canonical-mutation",
    passed: true,
    recordedAt: "2026-08-26T10:00:00.000Z",
    environment: {
      framekitVersion: "0.1.0",
      gitCommit: "0123456789abcdef0123456789abcdef01234567",
      nodeVersion: "v22.15.0",
      platform: "darwin",
      architecture: "arm64",
      osVersion: "Darwin Kernel Version 25.5.0",
    },
    editor: {
      name: "Final Cut Pro",
      version: "10.7.1",
      backend: "workflow-extension-ipc",
    },
    capabilities: {
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
    },
    project: {
      id: "final-cut:project:disposable",
      name: "Framekit Canonical E2E",
      sequenceId: "final-cut:sequence:disposable",
    },
    target: {
      occurrenceId: "final-cut:occurrence:one",
      mediaId: "final-cut:media:one",
    },
    mutation: {
      operation: "rename-clip",
      status: "VERIFIED",
      timelineChanged: true,
      beforeRevision: { id: "rev-10", sequence: 10, timestamp: "2026-08-26T10:00:01.000Z" },
      afterRevision: { id: "rev-11", sequence: 11, timestamp: "2026-08-26T10:00:02.000Z" },
      diff: {
        addedCount: 0,
        removedCount: 0,
        modifiedCount: 1,
        modifiedItemIds: ["final-cut:occurrence:one"],
        durationDelta: 0,
        affectedRangeCount: 0,
      },
    },
    restoration: {
      operation: "edit.undo",
      status: "VERIFIED",
      restored: true,
      beforeDigest: "before-digest",
      restoredDigest: "before-digest",
      restoredRevision: { id: "rev-12", sequence: 12, timestamp: "2026-08-26T10:00:03.000Z" },
    },
    sanitization: {
      strategy: "allowlisted-summary",
      omitted: ["media sources", "raw snapshots", "transaction identifiers", "diagnostics"],
    },
  });

  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes("/Users/private/secret-footage.mov"), false);
  assert.equal(serialized.includes("do not publish this credential"), false);
  assert.equal(serialized.includes("raw crash dump"), false);
  assert.equal(serialized.includes("transaction-secret"), false);
});

const baseRevision = (id: string, sequence: number, timestamp: string) => ({ id, sequence, timestamp });

const rawRun = {
  passed: true,
  recordedAt: "2026-08-26T10:00:00.000Z",
  editor: { name: "Final Cut Pro", version: "10.7.1", backend: "workflow-extension-ipc" },
  capabilities: {
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
      secret: "do not publish this credential",
    },
    analyzers: { speechTranscribe: false, speechVad: false, audioLoudness: false, visualTrack: false },
  },
  project: {
    id: "final-cut:project:disposable",
    name: "Framekit Canonical E2E",
    sequenceId: "final-cut:sequence:disposable",
  },
  target: { occurrenceId: "final-cut:occurrence:one", mediaId: "final-cut:media:one" },
  editStatus: "VERIFIED",
  before: snapshot("Interview", baseRevision("rev-10", 10, "2026-08-26T10:00:01.000Z")),
  after: snapshot("Interview [Framekit E2E]", baseRevision("rev-11", 11, "2026-08-26T10:00:02.000Z")),
  diff: {
    from: baseRevision("rev-10", 10, "2026-08-26T10:00:01.000Z"),
    to: baseRevision("rev-11", 11, "2026-08-26T10:00:02.000Z"),
    added: [],
    removed: [],
    modified: [{
      type: "ITEM_MODIFIED",
      itemId: "final-cut:occurrence:one",
      before: { name: "Interview" },
      after: { name: "Interview [Framekit E2E]" },
    }],
    durationDelta: 0,
    affectedRanges: [],
    rawDiagnostics: "raw crash dump",
  },
  restored: snapshot("Interview", baseRevision("rev-12", 12, "2026-08-26T10:00:03.000Z")),
  digests: { before: "before-digest", restored: "before-digest" },
  transactionId: "transaction-secret",
};

function snapshot(name: string, revision: { id: string; sequence: number; timestamp: string }) {
  return {
    projectId: "final-cut:project:disposable",
    projectName: "Framekit Canonical E2E",
    timeline: {
      id: "final-cut:sequence:disposable",
      name: "Framekit Canonical E2E",
      duration: 30,
      clips: [{
        id: "final-cut:occurrence:one",
        mediaId: "final-cut:media:one",
        name,
        start: 0,
        duration: 30,
        track: 0,
        startTime: { value: "0", timescale: "1" },
        durationTime: { value: "30", timescale: "1" },
      }],
      storyElements: [],
      markers: [],
      captions: [],
    },
    media: [{
      mediaId: "final-cut:media:one",
      source: "/Users/private/secret-footage.mov",
      mediaKind: "video",
      duration: 30,
    }],
    revision,
  };
}
