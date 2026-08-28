import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { sanitizeCanonicalEvidence, sanitizeCanonicalReadEvidence } from "../../scripts/final-cut-evidence.mjs";

test("canonical headed runner publishes the sanitized evidence contract", async () => {
  const runner = await readFile(join(process.cwd(), "scripts/final-cut-canonical-headed-e2e.mjs"), "utf8");

  assert.match(runner, /sanitizeCanonicalEvidence/);
  assert.match(runner, /evidenceEnvironment\(root\)/);
  assert.match(runner, /editStatus: transaction\.status/);
  assert.match(runner, /JSON\.stringify\(evidence, null, 2\)/);
});

test("canonical headed read runner publishes a read-only sanitized evidence contract", async () => {
  const runner = await readFile(join(process.cwd(), "scripts/final-cut-canonical-read-headed-e2e.mjs"), "utf8");

  assert.match(runner, /sanitizeCanonicalReadEvidence/);
  assert.match(runner, /project\.list/);
  assert.match(runner, /project\.inspect/);
  assert.doesNotMatch(runner, /timeline\.edit/);
  assert.match(runner, /JSON\.stringify\(evidence, null, 2\)/);
});

test("canonical headed evidence documentation describes the sanitized review boundary", async () => {
  const documentation = await readFile(join(process.cwd(), "docs/tests/final-cut-live-e2e.md"), "utf8");

  assert.match(documentation, /sanitized evidence document/);
  assert.match(documentation, /full Git commit/);
  assert.match(documentation, /tool results/);
  assert.match(documentation, /raw snapshots/);
  assert.match(documentation, /private media paths/);
});

test("canonical headed evidence keeps mutation proof while omitting private snapshot data", () => {
  const evidence = sanitizeCanonicalEvidence(rawRun, {
    framekitVersion: "0.1.0",
    finalCutVersion: "10.7.1",
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
      finalCutVersion: "10.7.1",
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
    toolResults: [
      { name: "editor.inspect", status: "passed" },
      { name: "project.inspect", status: "passed" },
      { name: "timeline.edit", status: "VERIFIED" },
      { name: "edit.undo", status: "passed" },
    ],
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

test("canonical headed evidence requires an exact full Git commit", () => {
  assert.throws(
    () => sanitizeCanonicalEvidence(rawRun, {
      framekitVersion: "0.1.0",
      finalCutVersion: "10.7.1",
      gitCommit: "HEAD",
      nodeVersion: "v22.15.0",
      platform: "darwin",
      architecture: "arm64",
      osVersion: "Darwin Kernel Version 25.5.0",
    }),
    /FINAL_CUT_E2E_EVIDENCE_INCOMPLETE: Git commit must be a full SHA-1/,
  );
});

test("canonical headed evidence rejects a non-advancing mutation revision", () => {
  const nonAdvancingRun = structuredClone(rawRun);
  nonAdvancingRun.after.revision = structuredClone(nonAdvancingRun.before.revision);

  assert.throws(
    () => sanitizeCanonicalEvidence(nonAdvancingRun, {
      framekitVersion: "0.1.0",
      finalCutVersion: "10.7.1",
      gitCommit: "0123456789abcdef0123456789abcdef01234567",
      nodeVersion: "v22.15.0",
      platform: "darwin",
      architecture: "arm64",
      osVersion: "Darwin Kernel Version 25.5.0",
    }),
    /FINAL_CUT_E2E_EVIDENCE_INCOMPLETE: canonical mutation revision did not advance/,
  );
});

test("canonical headed evidence rejects malformed summary scalar values", () => {
  const malformedDurationRun = structuredClone(rawRun);
  Reflect.set(malformedDurationRun.diff, "durationDelta", { value: 0 });
  assert.throws(
    () => sanitizeCanonicalEvidence(malformedDurationRun, {
      framekitVersion: "0.1.0",
      finalCutVersion: "10.7.1",
      gitCommit: "0123456789abcdef0123456789abcdef01234567",
      nodeVersion: "v22.15.0",
      platform: "darwin",
      architecture: "arm64",
      osVersion: "Darwin Kernel Version 25.5.0",
    }),
    /FINAL_CUT_E2E_EVIDENCE_INCOMPLETE: duration delta must be a finite number/,
  );

  const malformedSequenceRun = structuredClone(rawRun);
  Reflect.set(malformedSequenceRun.before.revision, "sequence", "10");
  assert.throws(
    () => sanitizeCanonicalEvidence(malformedSequenceRun, {
      framekitVersion: "0.1.0",
      finalCutVersion: "10.7.1",
      gitCommit: "0123456789abcdef0123456789abcdef01234567",
      nodeVersion: "v22.15.0",
      platform: "darwin",
      architecture: "arm64",
      osVersion: "Darwin Kernel Version 25.5.0",
    }),
    /FINAL_CUT_E2E_EVIDENCE_INCOMPLETE: revision sequence must be a non-negative integer/,
  );
});

test("canonical headed evidence rejects metadata-only capability claims", () => {
  const metadataOnlyRun = structuredClone(rawRun);
  metadataOnlyRun.capabilities.editor.canonicalTimelineMode = "metadata-only";

  assert.throws(
    () => sanitizeCanonicalEvidence(metadataOnlyRun, {
      framekitVersion: "0.1.0",
      finalCutVersion: "10.7.1",
      gitCommit: "0123456789abcdef0123456789abcdef01234567",
      nodeVersion: "v22.15.0",
      platform: "darwin",
      architecture: "arm64",
      osVersion: "Darwin Kernel Version 25.5.0",
    }),
    /FINAL_CUT_E2E_EVIDENCE_INCOMPLETE: canonical-write capability is required/,
  );
});

test("canonical headed evidence rejects path-like malformed capability values", () => {
  const malformedRun = structuredClone(rawRun);
  Reflect.set(malformedRun.capabilities.editor, "timelineWrite", "/Users/private/credentials.txt");

  assert.throws(
    () => sanitizeCanonicalEvidence(malformedRun, {
      framekitVersion: "0.1.0",
      finalCutVersion: "10.7.1",
      gitCommit: "0123456789abcdef0123456789abcdef01234567",
      nodeVersion: "v22.15.0",
      platform: "darwin",
      architecture: "arm64",
      osVersion: "Darwin Kernel Version 25.5.0",
    }),
    /FINAL_CUT_E2E_EVIDENCE_INCOMPLETE: timelineWrite capability must be boolean/,
  );
});

test("canonical headed read evidence keeps snapshot shape proof while omitting private media data", () => {
  const evidence = sanitizeCanonicalReadEvidence(readRun, {
    framekitVersion: "0.1.0",
    finalCutVersion: "10.7.1",
    gitCommit: "0123456789abcdef0123456789abcdef01234567",
    nodeVersion: "v22.15.0",
    platform: "darwin",
    architecture: "arm64",
    osVersion: "Darwin Kernel Version 25.5.0",
  });

  assert.deepEqual(evidence, {
    schemaVersion: 1,
    evidenceType: "headed-native-canonical-read",
    passed: true,
    recordedAt: "2026-08-26T10:00:00.000Z",
    environment: {
      framekitVersion: "0.1.0",
      finalCutVersion: "10.7.1",
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
        canonicalTimelineMode: "canonical-read",
        projectRead: true,
        timelineSnapshotRead: true,
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
    snapshot: {
      revision: { id: "rev-10", sequence: 10, timestamp: "2026-08-26T10:00:01.000Z" },
      timeline: {
        id: "final-cut:sequence:disposable",
        name: "Framekit Canonical E2E",
        duration: 30,
        durationTime: { value: "30", timescale: "1" },
        clipCount: 1,
        storyElementCount: 1,
        markerCount: 0,
        captionCount: 0,
        exactCoordinateCounts: { clips: 1, storyElements: 1, markers: 0, captions: 0 },
      },
      mediaCount: 1,
    },
    sanitization: {
      strategy: "allowlisted-summary",
      omitted: ["media sources", "raw snapshots", "diagnostics"],
    },
  });

  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes("/Users/private/secret-footage.mov"), false);
  assert.equal(serialized.includes("do not publish this credential"), false);
  assert.equal(serialized.includes("raw crash dump"), false);
});

test("canonical headed read evidence rejects a metadata-only bridge", () => {
  const metadataOnlyRun = structuredClone(readRun);
  metadataOnlyRun.capabilities.editor.canonicalTimelineMode = "metadata-only";

  assert.throws(
    () => sanitizeCanonicalReadEvidence(metadataOnlyRun, {
      framekitVersion: "0.1.0",
      finalCutVersion: "10.7.1",
      gitCommit: "0123456789abcdef0123456789abcdef01234567",
      nodeVersion: "v22.15.0",
      platform: "darwin",
      architecture: "arm64",
      osVersion: "Darwin Kernel Version 25.5.0",
    }),
    /FINAL_CUT_E2E_EVIDENCE_INCOMPLETE: canonical-read or canonical-write capability is required/,
  );
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
  toolResults: [
    { name: "editor.inspect", status: "passed" },
    { name: "project.inspect", status: "passed" },
    { name: "timeline.edit", status: "VERIFIED" },
    { name: "edit.undo", status: "passed" },
  ],
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

const readRun = {
  passed: true,
  recordedAt: "2026-08-26T10:00:00.000Z",
  editor: { name: "Final Cut Pro", version: "10.7.1", backend: "workflow-extension-ipc" },
  capabilities: {
    editor: {
      canonicalTimelineMode: "canonical-read",
      projectRead: true,
      timelineSnapshotRead: true,
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
      secret: "do not publish this credential",
    },
    analyzers: { speechTranscribe: false, speechVad: false, audioLoudness: false, visualTrack: false },
  },
  project: {
    id: "final-cut:project:disposable",
    name: "Framekit Canonical E2E",
    sequenceId: "final-cut:sequence:disposable",
  },
  catalog: {
    activeProjectId: "final-cut:project:disposable",
    activeSequenceId: "final-cut:sequence:disposable",
  },
  snapshot: {
    projectId: "final-cut:project:disposable",
    projectName: "Framekit Canonical E2E",
    timeline: {
      id: "final-cut:sequence:disposable",
      name: "Framekit Canonical E2E",
      duration: 30,
      durationTime: { value: "30", timescale: "1" },
      clips: [{
        id: "final-cut:occurrence:one",
        mediaId: "final-cut:media:one",
        name: "Interview",
        start: 0,
        duration: 30,
        track: 0,
        startTime: { value: "0", timescale: "1" },
        durationTime: { value: "30", timescale: "1" },
      }],
      storyElements: [{
        id: "final-cut:occurrence:one",
        kind: "asset-clip",
        start: 0,
        duration: 30,
        startTime: { value: "0", timescale: "1" },
        durationTime: { value: "30", timescale: "1" },
        lane: 0,
        mediaId: "final-cut:media:one",
      }],
      markers: [],
      captions: [],
    },
    media: [{
      mediaId: "final-cut:media:one",
      source: "/Users/private/secret-footage.mov",
      mediaKind: "video",
      duration: 30,
    }],
    revision: baseRevision("rev-10", 10, "2026-08-26T10:00:01.000Z"),
  },
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
