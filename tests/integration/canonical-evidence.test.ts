import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { join } from "node:path";
import { buildFinalCutCanonicalExportScript } from "../../adapters/final-cut/typescript/src/canonical.js";
import { canonicalSnapshotDigest } from "../../packages/runtime/src/timeline/snapshot-digest.js";
import { canonicalEvidenceDigest, hashCanonicalSourceMedia, sanitizeCanonicalEvidence, sanitizeCanonicalReadEvidence } from "../../scripts/final-cut-evidence.mjs";
import { loadNativeEditingManifest, summarizeHeadedEvidence } from "../release-gate/native-editing.js";

test("canonical export resolves the Final Cut save field by stable accessibility id", () => {
  const script = buildFinalCutCanonicalExportScript("/tmp/framekit/active.fcpxml");

  assert.match(script, /id of candidate/);
  assert.match(script, /PathTextField/);
  assert.match(script, /saveAsNameTextField/);
  assert.match(script, /focusedCandidate.*matchesCanonicalPathField/s);
});

test("canonical headed runner publishes the sanitized evidence contract", async () => {
  const runner = await readFile(join(process.cwd(), "scripts/final-cut-canonical-headed-e2e.mjs"), "utf8");

  assert.match(runner, /sanitizeCanonicalEvidence/);
  assert.match(runner, /evidenceEnvironment\(root\)/);
  assert.match(runner, /editStatus: transaction\.status/);
  assert.match(runner, /FRAMEKIT_FINAL_CUT_CANONICAL_PROVIDER: "native"/);
  assert.match(runner, /FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "1"/);
  assert.match(runner, /JSON\.stringify\(evidence, null, 2\)/);
});

test("canonical headed runner rejects unsafe targets before mutation", async () => {
  const runner = await readFile(join(process.cwd(), "scripts/final-cut-canonical-headed-e2e.mjs"), "utf8");

  const staleProbe = runner.indexOf('status: "rejected-stale-context"');
  const targetProbe = runner.indexOf('status: "rejected-target-mismatch"');
  const verifiedMutation = runner.indexOf("const transaction = await previewAndExecuteCanonicalRename");
  assert.ok(staleProbe >= 0 && staleProbe < verifiedMutation);
  assert.ok(targetProbe >= 0 && targetProbe < verifiedMutation);
  assert.match(runner, /STALE_CONTEXT/);
  assert.match(runner, /TARGET_MISMATCH/);
  assert.match(runner, /canonicalDigest\(afterStaleProbe\).*beforeDigest/s);
  assert.match(runner, /canonicalDigest\(afterTargetProbe\).*beforeDigest/s);
  assert.match(runner, /sameRevision\(afterStaleProbe\.revision,\s*before\.revision\)/);
  assert.match(runner, /sameRevision\(afterTargetProbe\.revision,\s*before\.revision\)/);
});

test("canonical headed read runner publishes a read-only sanitized evidence contract", async () => {
  const runner = await readFile(join(process.cwd(), "scripts/final-cut-canonical-read-headed-e2e.mjs"), "utf8");

  assert.match(runner, /sanitizeCanonicalReadEvidence/);
  assert.match(runner, /readBoundNativeProject\(callJson, expectedProject/);
  assert.doesNotMatch(runner, /timeline\.edit/);
  assert.match(runner, /JSON\.stringify\(evidence, null, 2\)/);
});

test("canonical headed evidence keeps mutation proof while omitting private snapshot data", () => {
  assert.equal(canonicalEvidenceDigest(rawRun.before), canonicalSnapshotDigest(rawRun.before as never));
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
        semanticOperations: { "rename-clip": true, "trim-clip": false, "add-marker": true, "ripple-delete": false, "set-gain": false },
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
    sourceMediaIntegrity: { sourceCount: 1, digests: ["c".repeat(64)] },
    toolResults: [
      { name: "editor.inspect", status: "passed" },
      { name: "project.list", status: "passed" },
      { name: "project.inspect", status: "passed" },
      { name: "project.select", status: "passed" },
      { name: "project.inspect", status: "passed" },
      { name: "editor.inspect", status: "passed" },
      { name: "editor.timeline.edit", status: "rejected-stale-context" },
      { name: "project.inspect", status: "unchanged" },
      { name: "editor.timeline.edit", status: "rejected-target-mismatch" },
      { name: "project.inspect", status: "unchanged" },
      { name: "editor.timeline.edit.preview", status: "passed" },
      { name: "project.inspect", status: "unchanged" },
      { name: "editor.timeline.edit.execute", status: "VERIFIED" },
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
      beforeDigest: canonicalEvidenceDigest(rawRun.before),
      restoredDigest: canonicalEvidenceDigest(rawRun.restored),
      restoredRevision: { id: "rev-12", sequence: 12, timestamp: "2026-08-26T10:00:03.000Z" },
    },
    sanitization: {
      strategy: "allowlisted-summary",
      omitted: ["media sources", "raw snapshots", "transaction identifiers", "diagnostics"],
    },
  });

  const canonicalWorkflow = loadNativeEditingManifest().workflows.find((workflow) => workflow.id === "canonical-live");
  assert.ok(canonicalWorkflow);
  assert.equal(summarizeHeadedEvidence(evidence, canonicalWorkflow).status, "verified");

  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes("/Users/private/secret-footage.mov"), false);
  assert.equal(serialized.includes("do not publish this credential"), false);
  assert.equal(serialized.includes("raw crash dump"), false);
  assert.equal(serialized.includes("transaction-secret"), false);
});

test("evidence and runtime digests agree when exact source bounds are supplied", () => {
  const snapshot = structuredClone(rawRun.before);
  Object.assign(snapshot.media[0]!, { sourceRange: { start: { value: "10", timescale: "1" }, duration: { value: "20", timescale: "1" } } });
  assert.equal(canonicalEvidenceDigest(snapshot), canonicalSnapshotDigest(snapshot as never));
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

test("canonical headed evidence rejects malformed digest values", () => {
  const malformedDigestRun = structuredClone(rawRun);
  const privateDigest = { source: "/Users/private/secret-footage.mov" };
  Reflect.set(malformedDigestRun.digests, "before", privateDigest);
  Reflect.set(malformedDigestRun.digests, "restored", privateDigest);

  assert.throws(
    () => sanitizeCanonicalEvidence(malformedDigestRun, {
      framekitVersion: "0.1.0",
      finalCutVersion: "10.7.1",
      gitCommit: "0123456789abcdef0123456789abcdef01234567",
      nodeVersion: "v22.15.0",
      platform: "darwin",
      architecture: "arm64",
      osVersion: "Darwin Kernel Version 25.5.0",
    }),
    /FINAL_CUT_E2E_EVIDENCE_INCOMPLETE: before digest must be a 64-character SHA-256 hexadecimal string/,
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
      semanticOperations: { "rename-clip": true, "trim-clip": false, "add-marker": true, "ripple-delete": false, "set-gain": false },
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
    { name: "project.list", status: "passed" },
    { name: "project.inspect", status: "passed" },
    { name: "project.select", status: "passed" },
    { name: "project.inspect", status: "passed" },
    { name: "editor.inspect", status: "passed" },
    { name: "editor.timeline.edit", status: "rejected-stale-context" },
    { name: "project.inspect", status: "unchanged" },
    { name: "editor.timeline.edit", status: "rejected-target-mismatch" },
    { name: "project.inspect", status: "unchanged" },
    { name: "editor.timeline.edit.preview", status: "passed" },
    { name: "project.inspect", status: "unchanged" },
    { name: "editor.timeline.edit.execute", status: "VERIFIED" },
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
  sourceIntegrity: {
    before: [{ mediaId: "final-cut:media:one", sha256: "c".repeat(64) }],
    restored: [{ mediaId: "final-cut:media:one", sha256: "c".repeat(64) }],
  },
  digests: {
    before: canonicalEvidenceDigest(snapshot("Interview", baseRevision("rev-10", 10, "2026-08-26T10:00:01.000Z"))),
    restored: canonicalEvidenceDigest(snapshot("Interview", baseRevision("rev-12", 12, "2026-08-26T10:00:03.000Z"))),
  },
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

test("canonical evidence rejects fabricated restoration and mismatched target bindings", () => {
  const environment = {
    framekitVersion: "0.1.0", finalCutVersion: "10.7.1", gitCommit: "0123456789abcdef0123456789abcdef01234567",
    nodeVersion: "v22.15.0", platform: "darwin", architecture: "arm64", osVersion: "Darwin",
  };
  const cases = [
    (run: typeof rawRun) => { run.restored.media[0]!.source = "/different/secret-footage.mov"; },
    (run: typeof rawRun) => { run.after.projectId = "different-project"; },
    (run: typeof rawRun) => { run.after.timeline.id = "different-sequence"; },
    (run: typeof rawRun) => { run.after.timeline.clips[0]!.mediaId = "different-media"; },
    (run: typeof rawRun) => { run.after.media[0]!.source = "/different/secret-footage.mov"; },
    (run: typeof rawRun) => { run.after.timeline.clips.push(structuredClone(run.after.timeline.clips[0]!)); },
  ];
  for (const corrupt of cases) {
    const run = structuredClone(rawRun);
    corrupt(run);
    assert.throws(() => sanitizeCanonicalEvidence(run, environment), /FINAL_CUT_E2E_EVIDENCE_INCOMPLETE/);
  }
});

test("canonical evidence rejects collateral edits and accepts equivalent rational time", () => {
  const environment = {
    framekitVersion: "0.1.0", finalCutVersion: "10.7.1", gitCommit: "0123456789abcdef0123456789abcdef01234567",
    nodeVersion: "v22.15.0", platform: "darwin", architecture: "arm64", osVersion: "Darwin",
  };
  const equivalent = structuredClone(rawRun);
  equivalent.after.timeline.clips[0]!.durationTime = { value: "60", timescale: "2" };
  assert.doesNotThrow(() => sanitizeCanonicalEvidence(equivalent, environment));
  const trimmed = structuredClone(rawRun);
  trimmed.after.timeline.clips[0]!.duration = 29;
  trimmed.after.timeline.clips[0]!.durationTime = { value: "29", timescale: "1" };
  assert.throws(() => sanitizeCanonicalEvidence(trimmed, environment), /FINAL_CUT_E2E_EVIDENCE_INCOMPLETE.*collateral/i);
  const extraMarker = structuredClone(rawRun);
  (extraMarker.after.timeline.markers as unknown[]).push({ id: "unexpected", start: 1, duration: 0, name: "unexpected" });
  assert.throws(() => sanitizeCanonicalEvidence(extraMarker, environment), /FINAL_CUT_E2E_EVIDENCE_INCOMPLETE.*collateral/i);
});

test("canonical evidence requires the advertised rename capability and a new restored revision", () => {
  const environment = {
    framekitVersion: "0.1.0", finalCutVersion: "10.7.1", gitCommit: "0123456789abcdef0123456789abcdef01234567",
    nodeVersion: "v22.15.0", platform: "darwin", architecture: "arm64", osVersion: "Darwin",
  };
  for (const corrupt of [
    (run: typeof rawRun) => { (run.capabilities.editor as { semanticOperations?: unknown }).semanticOperations = { "rename-clip": false }; },
    (run: typeof rawRun) => { delete (run.capabilities.editor as { semanticOperations?: unknown }).semanticOperations; },
    (run: typeof rawRun) => { run.restored.revision = structuredClone(run.after.revision); },
    (run: typeof rawRun) => { run.after.projectName = "different project name"; },
    (run: typeof rawRun) => { run.digests.before = "a".repeat(64); run.digests.restored = "a".repeat(64); },
  ]) {
    const run = structuredClone(rawRun);
    corrupt(run);
    assert.throws(() => sanitizeCanonicalEvidence(run, environment), /FINAL_CUT_E2E_EVIDENCE_INCOMPLETE/);
  }
});

test("canonical evidence rejects missing, mismatched, or ambiguous source hashes", () => {
  const environment = {
    framekitVersion: "0.1.0", finalCutVersion: "10.7.1", gitCommit: "0123456789abcdef0123456789abcdef01234567",
    nodeVersion: "v22.15.0", platform: "darwin", architecture: "arm64", osVersion: "Darwin",
  };
  for (const corrupt of [
    (run: typeof rawRun) => { Reflect.deleteProperty(run, "sourceIntegrity"); },
    (run: typeof rawRun) => { run.sourceIntegrity.restored[0]!.sha256 = "d".repeat(64); },
    (run: typeof rawRun) => { run.sourceIntegrity.restored[0]!.mediaId = "different"; },
    (run: typeof rawRun) => { run.sourceIntegrity.before.push(structuredClone(run.sourceIntegrity.before[0]!)); },
  ]) {
    const run = structuredClone(rawRun);
    corrupt(run);
    assert.throws(() => sanitizeCanonicalEvidence(run, environment), /FINAL_CUT_E2E_EVIDENCE_INCOMPLETE.*source/i);
  }
});

test("canonical source hashing is content-bound and does not follow symlinks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-evidence-source-hash-"));
  const path = join(directory, "fixture.mov");
  const alias = join(directory, "alias.mov");
  try {
    await writeFile(path, "fixture media");
    await symlink(path, alias);
    const project = structuredClone(rawRun.before);
    project.media[0]!.source = path;
    const hashes = await hashCanonicalSourceMedia(project);
    assert.deepEqual(hashes, [{ mediaId: "final-cut:media:one", sha256: createHash("sha256").update("fixture media").digest("hex") }]);
    assert.doesNotMatch(JSON.stringify(hashes), /fixture\.mov|framekit-evidence-source-hash/);
    project.media[0]!.source = pathToFileURL(path).href;
    assert.deepEqual(await hashCanonicalSourceMedia(project), hashes);
    await writeFile(path, "modified fixture media");
    assert.notEqual((await hashCanonicalSourceMedia(project))[0]!.sha256, hashes[0]!.sha256);
    project.media[0]!.source = alias;
    await assert.rejects(hashCanonicalSourceMedia(project), /FINAL_CUT_E2E_SOURCE_HASH_UNAVAILABLE/);
    project.media[0]!.source = "https://example.test/fixture.mov";
    await assert.rejects(hashCanonicalSourceMedia(project), /FINAL_CUT_E2E_SOURCE_HASH_UNAVAILABLE/);
    project.media[0]!.source = path;
    project.media.push(structuredClone(project.media[0]!));
    await assert.rejects(hashCanonicalSourceMedia(project), /FINAL_CUT_E2E_SOURCE_HASH_UNAVAILABLE/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("canonical headed runner captures source hashes before editing and after undo", async () => {
  const runner = await readFile(join(process.cwd(), "scripts/final-cut-canonical-headed-e2e.mjs"), "utf8");
  const beforeHash = runner.indexOf("await hashCanonicalSourceMedia(before)");
  const edit = runner.indexOf("const transaction = await previewAndExecuteCanonicalRename");
  const undo = runner.indexOf('await callJson("edit.undo"');
  const restoredHash = runner.indexOf("await hashCanonicalSourceMedia(restored)");
  assert.ok(beforeHash >= 0 && beforeHash < edit);
  assert.ok(undo > edit && restoredHash > undo);
  assert.match(runner, /sourceIntegrity:\s*\{\s*before:\s*sourceHashesBefore,\s*restored:\s*sourceHashesRestored\s*\}/);
});

test("canonical write target is bound before selection and every headed read", async () => {
  const { selectCanonicalWriteTarget, readCanonicalWriteTarget } = await import("../../scripts/final-cut-canonical-write-target.mjs");
  const calls: Array<[string, unknown]> = [];
  const expected = { projectId: "p", projectName: "Disposable", sequenceId: "s" };
  const call = async (name: string, args?: unknown) => {
    calls.push([name, args]);
    if (name === "project.list") return { activeProjectId: "p", activeSequenceId: "s", projects: [{ id: "p", name: "Disposable", sequences: [{ id: "s" }] }] };
    if (name === "project.select") return { activeProjectId: "p", activeSequenceId: "s" };
    if (name === "project.inspect") return { projectId: "p", projectName: "Disposable", timeline: { id: "s" }, revision: { id: "r" } };
    throw new Error(`unexpected ${name}`);
  };
  await selectCanonicalWriteTarget(call, expected, "r");
  await readCanonicalWriteTarget(call, expected);
  await readCanonicalWriteTarget(call, expected);
  assert.deepEqual(calls, [
    ["project.list", undefined],
    ["project.inspect", { confirmHeadedRead: true, expectedTarget: { projectId: "p", sequenceId: "s" } }],
    ["project.select", { projectId: "p", sequenceId: "s" }],
    ...Array(2).fill(["project.inspect", { confirmHeadedRead: true, expectedTarget: { projectId: "p", sequenceId: "s" } }]),
  ]);
});

test("canonical write target rejects different or ambiguous catalog identities before selection", async () => {
  const { selectCanonicalWriteTarget } = await import("../../scripts/final-cut-canonical-write-target.mjs");
  const expected = { projectId: "p", projectName: "Disposable", sequenceId: "s" };
  for (const catalog of [
    { activeProjectId: "other", activeSequenceId: "s", projects: [] },
    { activeProjectId: "p", activeSequenceId: "other", projects: [] },
    { activeProjectId: "p", activeSequenceId: "s", projects: [{ id: "p", name: "Disposable", sequences: [{ id: "s" }] }, { id: "p", name: "Disposable", sequences: [{ id: "s" }] }] },
    { activeProjectId: "p", activeSequenceId: "s", projects: [{ id: "p", name: "Other", sequences: [{ id: "s" }] }] },
  ]) {
    const calls: string[] = [];
    await assert.rejects(selectCanonicalWriteTarget(async (name: string) => { calls.push(name); return catalog; }, expected, "r"), /TARGET_MISMATCH/);
    assert.deepEqual(calls, ["project.list"]);
  }
});

test("canonical write read rejects a snapshot from another target", async () => {
  const { readCanonicalWriteTarget } = await import("../../scripts/final-cut-canonical-write-target.mjs");
  await assert.rejects(readCanonicalWriteTarget(async () => ({ projectId: "p", projectName: "Disposable", timeline: { id: "other" } }), { projectId: "p", projectName: "Disposable", sequenceId: "s" }), /TARGET_MISMATCH/);
});

test("canonical headed write runner requires explicit candidate and bound reads", async () => {
  const runner = await readFile(join(process.cwd(), "scripts/final-cut-canonical-headed-e2e.mjs"), "utf8");
  assert.match(runner, /FRAMEKIT_FINAL_CUT_E2E_PROJECT_ID/);
  assert.match(runner, /FRAMEKIT_FINAL_CUT_E2E_SEQUENCE_ID/);
  assert.match(runner, /FRAMEKIT_FINAL_CUT_E2E_CANDIDATE_COMMIT/);
  assert.match(runner, /FRAMEKIT_FINAL_CUT_E2E_ALLOW_MUTATION/);
  assert.match(runner, /selectCanonicalWriteTarget\(callJson, approvedTarget, approvedRevision\)/);
  assert.equal((runner.match(/readCanonicalWriteTarget\(callJson, approvedTarget\)/g) ?? []).length, 4);
  assert.doesNotMatch(runner, /callJson\("project\.inspect"\)/);
});

test("canonical headed runner never retries an uncertain undo", async () => {
  const runner = await readFile(join(process.cwd(), "scripts/final-cut-canonical-headed-e2e.mjs"), "utf8");
  assert.equal((runner.match(/callJson\("edit\.undo"/g) ?? []).length, 1);
});

test("canonical rename executes only its verified non-mutating preview", async () => {
  const { previewAndExecuteCanonicalRename } = await import("../../scripts/final-cut-canonical-rename.mjs");
  const before = structuredClone(rawRun.before);
  const calls: Array<[string, any]> = [];
  const expectedName = "Interview [Framekit E2E]";
  const preview = {
    previewToken: "preview-once", target: { kind: "editor.timeline", projectId: before.projectId, sequenceId: before.timeline.id },
    baseRevision: before.revision, operations: [{ type: "rename-clip", clipId: "final-cut:occurrence:one", name: expectedName }], warnings: [],
    expectedDiff: { added: [], removed: [], modified: [{ itemId: "final-cut:occurrence:one", before: structuredClone(before.timeline.clips[0]), after: { ...structuredClone(before.timeline.clips[0]), name: expectedName } }], durationDelta: 0, markerChanges: [], captionChanges: [], storyElementChanges: [], mediaChanges: [] },
  };
  const call = async (name: string, args: any) => { calls.push([name, args]); return name.endsWith(".preview") ? structuredClone(preview) : { status: "VERIFIED" }; };
  const result = await previewAndExecuteCanonicalRename(call, async () => structuredClone(before), before, "final-cut:occurrence:one", expectedName);
  assert.equal(result.status, "VERIFIED");
  assert.deepEqual(calls.map(([name]) => name), ["editor.timeline.edit.preview", "editor.timeline.edit.execute"]);
  assert.deepEqual(calls[1][1], { previewToken: "preview-once", path: "headed" });
  for (const fault of ["target", "operation", "diff", "warning", "changed", "revision"] as const) {
    const badPreview = structuredClone(preview);
    const observed = structuredClone(before);
    if (fault === "target") badPreview.target.sequenceId = "other";
    if (fault === "operation") badPreview.operations[0]!.name = "other";
    if (fault === "diff") badPreview.expectedDiff.mediaChanges.push({} as never);
    if (fault === "warning") badPreview.warnings.push("warning" as never);
    if (fault === "changed") observed.timeline.clips[0]!.name = "changed";
    if (fault === "revision") observed.revision.id = "changed";
    const attempted: string[] = [];
    await assert.rejects(previewAndExecuteCanonicalRename(async (name: string) => { attempted.push(name); return badPreview; }, async () => observed, before, "final-cut:occurrence:one", expectedName), /PREVIEW|STALE/);
    assert.deepEqual(attempted, ["editor.timeline.edit.preview"]);
  }
});


test("canonical rename preview works with the real runtime transaction contract", async () => {
  const { AgentVideoRuntime } = await import("@framekit/runtime");
  const { InMemoryEditorAdapter } = await import("@framekit/testkit");
  const { previewAndExecuteCanonicalRename } = await import("../../scripts/final-cut-canonical-rename.mjs");
  const adapter = new InMemoryEditorAdapter({ projectId: "p", projectName: "Disposable", timelineId: "s", timelineName: "Main", clips: [{ id: "clip", mediaId: "media", name: "Original", start: 0, duration: 5, track: 0 }], media: [{ mediaId: "media", source: "/fixture.mov", mediaKind: "video", duration: 5 }] });
  const runtime = new AgentVideoRuntime(adapter);
  const before = await runtime.inspectProject();
  const call = async (tool: string, args: any) => {
    if (tool === "editor.timeline.edit.preview") return runtime.previewTimelineEdit({ projectId: args.projectId, sequenceId: args.sequenceId }, { baseRevision: args.baseRevision, operations: args.operations });
    if (tool === "editor.timeline.edit.execute") return runtime.executeEdit(args.previewToken);
    throw new Error(`unexpected ${tool}`);
  };
  const transaction = await previewAndExecuteCanonicalRename(call, () => runtime.inspectProject(), before, "clip", "Renamed");
  assert.equal(transaction.status, "VERIFIED");
  assert.equal(transaction.after.timeline.clips[0].name, "Renamed");
});


test("canonical write checks the approved revision before selection", async () => {
  const { selectCanonicalWriteTarget } = await import("../../scripts/final-cut-canonical-write-target.mjs");
  const calls: string[] = [];
  const call = async (name: string) => {
    calls.push(name);
    return name === "project.list"
      ? { activeProjectId: "p", activeSequenceId: "s", projects: [{ id: "p", name: "Disposable", sequences: [{ id: "s" }] }] }
      : { projectId: "p", projectName: "Disposable", timeline: { id: "s" }, revision: { id: "other" } };
  };
  await assert.rejects(selectCanonicalWriteTarget(call, { projectId: "p", projectName: "Disposable", sequenceId: "s" }, "approved"), /STALE_CONTEXT/);
  assert.deepEqual(calls, ["project.list", "project.inspect"]);
});

test("canonical headed runner configures existing-socket-only connections", async () => {
  const runner = await readFile(join(process.cwd(), "scripts/final-cut-canonical-headed-e2e.mjs"), "utf8");
  const server = await readFile(join(process.cwd(), "apps/mcp-server/src/main.ts"), "utf8");
  assert.match(runner, /FRAMEKIT_FINAL_CUT_EXISTING_SOCKET_ONLY:\s*"1"/);
  assert.match(server, /existingSocketOnly:\s*process\.env\.FRAMEKIT_FINAL_CUT_EXISTING_SOCKET_ONLY === "1"/);
});
