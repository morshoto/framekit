import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeIncrementalSyncEvidence } from "../../scripts/final-cut-evidence.mjs";

const environment = {
  framekitVersion: "0.1.13",
  finalCutVersion: "10.7.1",
  gitCommit: "a".repeat(40),
  nodeVersion: "v22.19.0",
  platform: "darwin",
  architecture: "arm64",
  osVersion: "macOS 15.6",
};

const target = {
  projectId: "final-cut:project:qa",
  projectName: "Framekit QA",
  sequenceId: "final-cut:sequence:main",
};

const beforeRevision = {
  id: "revision-10",
  sequence: 10,
  timestamp: "2026-09-25T00:00:10.000Z",
};

const afterRevision = {
  id: "revision-11",
  sequence: 11,
  timestamp: "2026-09-25T00:00:11.000Z",
};

function rawEvidence() {
  return {
    passed: true,
    recordedAt: "2026-09-25T00:01:00.000Z",
    editor: { name: "Final Cut Pro", version: "10.7.1", backend: "final-cut-live" },
    capabilities: {
      editor: {
        canonicalTimelineMode: "canonical-read",
        projectRead: true,
        timelineSnapshotRead: true,
        incrementalChanges: true,
        projectCatalogRead: true,
        projectSelection: true,
      },
    },
    target,
    revisions: { before: beforeRevision, after: afterRevision },
    timelineChanges: {
      status: "ready",
      target: { projectId: target.projectId, sequenceId: target.sequenceId },
      source: {
        source: "Final Cut Pro",
        backend: "final-cut-live",
        guarantee: "canonical-read",
      },
      from: beforeRevision,
      to: afterRevision,
      changes: [{
        scope: "clip",
        type: "ITEM_MODIFIED",
        itemId: "occurrence-1",
        before: { name: "Opening" },
        after: { name: "Opening revised" },
      }],
    },
    contextChanges: {
      from: beforeRevision,
      to: afterRevision,
      changedScopes: ["timeline"],
      provenance: [{
        source: "canonical-timeline",
        provider: "final-cut",
        evidenceTier: "canonical-live",
        target: { projectId: target.projectId, sequenceId: target.sequenceId },
      }],
      timeline: { changes: [{ itemId: "occurrence-1" }] },
    },
    session: {
      createdState: "clean",
      staleState: "possibly_stale",
      blockedCode: "RECONCILIATION_REQUIRED",
      reconciledState: "rebased",
      resumedState: "rebased",
      baseRevision: beforeRevision,
      providerRevision: afterRevision,
    },
    rawSnapshot: { projectName: target.projectName },
    operationId: "private-operation-id",
  };
}

test("sanitizes target-bound headed incremental evidence", () => {
  const evidence = sanitizeIncrementalSyncEvidence(rawEvidence(), environment);

  assert.equal(evidence.evidenceType, "headed-native-incremental-sync");
  assert.deepEqual(evidence.target, target);
  assert.deepEqual(evidence.revisions, { before: beforeRevision, after: afterRevision });
  assert.deepEqual(evidence.timelineChanges, {
    status: "ready",
    target: { projectId: target.projectId, sequenceId: target.sequenceId },
    source: { backend: "final-cut-live", guarantee: "canonical-read" },
    from: beforeRevision,
    to: afterRevision,
    count: 1,
    scopes: ["clip"],
    itemIds: ["occurrence-1"],
    provenance: [{ operation: "modified", hasBefore: true, hasAfter: true }],
  });
  assert.deepEqual(evidence.contextChanges, {
    from: beforeRevision,
    to: afterRevision,
    changedScopes: ["timeline"],
    evidenceTiers: ["canonical-live"],
  });
  assert.deepEqual(evidence.session, {
    staleBlocked: true,
    blockedCode: "RECONCILIATION_REQUIRED",
    reconciled: true,
    resumed: true,
    baseRevision: beforeRevision,
    providerRevision: afterRevision,
  });
  assert.doesNotMatch(JSON.stringify(evidence), /"rawSnapshot"|private-operation-id|"sourcePath"|\/Users\//i);
});

test("rejects metadata-only or incomplete incremental evidence", () => {
  const metadataOnly = rawEvidence();
  metadataOnly.capabilities.editor.canonicalTimelineMode = "metadata-only";
  assert.throws(
    () => sanitizeIncrementalSyncEvidence(metadataOnly, environment),
    /canonical headed capability/,
  );

  const incomplete = rawEvidence();
  incomplete.session.blockedCode = "UNKNOWN";
  assert.throws(
    () => sanitizeIncrementalSyncEvidence(incomplete, environment),
    /reconciliation blocker/,
  );
});
