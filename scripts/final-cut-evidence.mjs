const editorCapabilityKeys = [
  "canonicalTimelineMode",
  "projectRead",
  "timelineSnapshotRead",
  "timelineWrite",
  "timelineArtifactWrite",
  "readAfterWrite",
  "incrementalChanges",
  "rollback",
  "assetDiscovery",
  "liveStateRead",
  "playheadWrite",
  "frameCapture",
  "playbackControl",
  "timelinePublishNewProject",
  "projectCatalogRead",
  "projectSelection",
  "compositeTransactions",
  "videoExport",
  "mediaImport",
  "mediaPlacement",
  "titlePlacement",
];

const analyzerCapabilityKeys = ["speechTranscribe", "speechVad", "audioLoudness", "visualTrack"];
const requiredToolResults = [
  ["editor.inspect", "passed"],
  ["project.inspect", "passed"],
  ["timeline.edit", "VERIFIED"],
  ["edit.undo", "passed"],
];

export function sanitizeCanonicalEvidence(run, environment) {
  assert(run?.passed === true, "headed run did not pass");
  assert(run.editStatus === "VERIFIED", "headed mutation was not verified");
  assert(run.editor, "editor identity is missing");
  assert(run.capabilities, "capability payload is missing");
  assert(run.capabilities.editor?.canonicalTimelineMode === "canonical-write", "canonical-write capability is required");
  assert(run.project && run.target, "project or target identity is missing");
  assert(run.before && run.after && run.restored && run.diff, "canonical snapshots or diff are missing");
  assert(run.digests?.before && run.digests?.restored, "canonical digests are missing");
  assert(run.digests.before === run.digests.restored, "restored digest does not match the pre-edit digest");

  const beforeTarget = findTarget(run.before, run.target.occurrenceId);
  const afterTarget = findTarget(run.after, run.target.occurrenceId);
  const restoredTarget = findTarget(run.restored, run.target.occurrenceId);
  assert(beforeTarget && afterTarget && restoredTarget, "target occurrence is missing from a canonical snapshot");
  assert(beforeTarget.name !== afterTarget.name, "canonical mutation did not change the target occurrence");
  assert(beforeTarget.name === restoredTarget.name, "restored target occurrence does not match the pre-edit state");

  const modifiedItemIds = (run.diff.modified ?? []).map((change) => change?.itemId).filter(isNonEmptyString);
  assert(modifiedItemIds.includes(run.target.occurrenceId), "canonical diff does not identify the target occurrence");

  return {
    schemaVersion: 1,
    evidenceType: "headed-native-canonical-mutation",
    passed: true,
    recordedAt: requireString(run.recordedAt, "recordedAt"),
    environment: sanitizeEnvironment(environment),
    editor: sanitizeIdentity(run.editor),
    capabilities: sanitizeCapabilities(run.capabilities),
    project: {
      id: requireString(run.project.id, "project id"),
      name: requireString(run.project.name, "project name"),
      sequenceId: requireString(run.project.sequenceId, "sequence id"),
    },
    target: {
      occurrenceId: requireString(run.target.occurrenceId, "occurrence id"),
      ...(isNonEmptyString(run.target.mediaId) ? { mediaId: run.target.mediaId } : {}),
    },
    toolResults: sanitizeToolResults(run.toolResults),
    mutation: {
      operation: "rename-clip",
      status: run.editStatus,
      timelineChanged: true,
      beforeRevision: summarizeRevision(run.before.revision),
      afterRevision: summarizeRevision(run.after.revision),
      diff: {
        addedCount: countChanges(run.diff.added),
        removedCount: countChanges(run.diff.removed),
        modifiedCount: modifiedItemIds.length,
        modifiedItemIds,
        durationDelta: run.diff.durationDelta,
        affectedRangeCount: countChanges(run.diff.affectedRanges),
      },
    },
    restoration: {
      operation: "edit.undo",
      status: "VERIFIED",
      restored: true,
      beforeDigest: run.digests.before,
      restoredDigest: run.digests.restored,
      restoredRevision: summarizeRevision(run.restored.revision),
    },
    sanitization: {
      strategy: "allowlisted-summary",
      omitted: ["media sources", "raw snapshots", "transaction identifiers", "diagnostics"],
    },
  };
}

function sanitizeEnvironment(environment) {
  const gitCommit = requireString(environment?.gitCommit, "Git commit");
  assert(/^[0-9a-f]{40}$/i.test(gitCommit), "Git commit must be a full SHA-1");
  return {
    framekitVersion: requireString(environment?.framekitVersion, "Framekit version"),
    gitCommit,
    nodeVersion: requireString(environment?.nodeVersion, "Node version"),
    platform: requireString(environment?.platform, "platform"),
    architecture: requireString(environment?.architecture, "architecture"),
    osVersion: requireString(environment?.osVersion, "OS version"),
  };
}

function sanitizeIdentity(identity) {
  return {
    name: requireString(identity.name, "editor name"),
    version: requireString(identity.version, "editor version"),
    backend: requireString(identity.backend, "editor backend"),
  };
}

function sanitizeCapabilities(capabilities) {
  return {
    editor: pickKnown(capabilities.editor, editorCapabilityKeys),
    analyzers: pickKnown(capabilities.analyzers, analyzerCapabilityKeys),
  };
}

function sanitizeToolResults(toolResults) {
  assert(Array.isArray(toolResults), "tool results are missing");
  assert(toolResults.length === requiredToolResults.length, "required tool results are incomplete");
  return toolResults.map((result, index) => {
    const [expectedName, expectedStatus] = requiredToolResults[index];
    const name = requireString(result?.name, "tool name");
    const status = requireString(result?.status, `tool ${name} status`);
    assert(name === expectedName && status === expectedStatus, `tool result ${index + 1} does not match the required headed workflow`);
    return { name, status };
  });
}

function pickKnown(value, keys) {
  const result = {};
  for (const key of keys) {
    if (value?.[key] !== undefined) result[key] = value[key];
  }
  return result;
}

function summarizeRevision(revision) {
  assert(revision, "revision is missing");
  return {
    id: requireString(revision.id, "revision id"),
    sequence: revision.sequence,
    timestamp: requireString(revision.timestamp, "revision timestamp"),
  };
}

function findTarget(snapshot, occurrenceId) {
  return snapshot.timeline?.clips?.find((clip) => clip?.id === occurrenceId);
}

function countChanges(changes) {
  return Array.isArray(changes) ? changes.length : 0;
}

function requireString(value, label) {
  assert(isNonEmptyString(value), `${label} is missing`);
  return value;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function assert(condition, message) {
  if (!condition) throw new Error(`FINAL_CUT_E2E_EVIDENCE_INCOMPLETE: ${message}`);
}
