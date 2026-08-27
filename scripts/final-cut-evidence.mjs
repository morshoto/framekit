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
  const beforeRevision = summarizeRevision(run.before.revision);
  const afterRevision = summarizeRevision(run.after.revision);
  const restoredRevision = summarizeRevision(run.restored.revision);
  assert(afterRevision.sequence > beforeRevision.sequence, "canonical mutation revision did not advance");

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
      beforeRevision,
      afterRevision,
      diff: {
        addedCount: countChanges(run.diff.added),
        removedCount: countChanges(run.diff.removed),
        modifiedCount: modifiedItemIds.length,
        modifiedItemIds,
        durationDelta: requireFiniteNumber(run.diff.durationDelta, "duration delta"),
        affectedRangeCount: countChanges(run.diff.affectedRanges),
      },
    },
    restoration: {
      operation: "edit.undo",
      status: "VERIFIED",
      restored: true,
      beforeDigest: run.digests.before,
      restoredDigest: run.digests.restored,
      restoredRevision,
    },
    sanitization: {
      strategy: "allowlisted-summary",
      omitted: ["media sources", "raw snapshots", "transaction identifiers", "diagnostics"],
    },
  };
}

export function sanitizeCanonicalReadEvidence(run, environment) {
  assert(run?.passed === true, "headed read did not pass");
  assert(run.editor, "editor identity is missing");
  assert(run.capabilities, "capability payload is missing");
  const capabilities = sanitizeCapabilities(run.capabilities);
  assert(
    capabilities.editor.canonicalTimelineMode === "canonical-read"
      || capabilities.editor.canonicalTimelineMode === "canonical-write",
    "canonical-read or canonical-write capability is required",
  );
  assert(run.project && run.catalog && run.snapshot, "project, catalog, or canonical snapshot is missing");
  assert(run.catalog.activeProjectId === run.project.id, "catalog active project does not match the requested target");
  assert(run.catalog.activeSequenceId === run.project.sequenceId, "catalog active sequence does not match the requested target");
  assert(run.snapshot.projectId === run.project.id, "snapshot project does not match the requested target");
  assert(run.snapshot.projectName === run.project.name, "snapshot project name does not match the requested target");
  assert(run.snapshot.timeline.id === run.project.sequenceId, "snapshot sequence does not match the requested target");
  const snapshot = validateReadSnapshot(run.snapshot);

  return {
    schemaVersion: 1,
    evidenceType: "headed-native-canonical-read",
    passed: true,
    recordedAt: requireString(run.recordedAt, "recordedAt"),
    environment: sanitizeEnvironment(environment),
    editor: sanitizeIdentity(run.editor),
    capabilities,
    project: {
      id: requireString(run.project.id, "project id"),
      name: requireString(run.project.name, "project name"),
      sequenceId: requireString(run.project.sequenceId, "sequence id"),
    },
    snapshot: {
      revision: summarizeRevision(snapshot.revision),
      timeline: {
        id: requireString(snapshot.timeline.id, "timeline id"),
        name: requireString(snapshot.timeline.name, "timeline name"),
        duration: requireFiniteNumber(snapshot.timeline.duration, "timeline duration"),
        durationTime: snapshot.timeline.durationTime,
        clipCount: snapshot.timeline.clips.length,
        storyElementCount: snapshot.timeline.storyElements.length,
        markerCount: snapshot.timeline.markers.length,
        captionCount: snapshot.timeline.captions.length,
        exactCoordinateCounts: {
          clips: snapshot.timeline.clips.length,
          storyElements: snapshot.timeline.storyElements.length,
          markers: snapshot.timeline.markers.length,
          captions: snapshot.timeline.captions.length,
        },
      },
      mediaCount: snapshot.media.length,
    },
    sanitization: {
      strategy: "allowlisted-summary",
      omitted: ["media sources", "raw snapshots", "diagnostics"],
    },
  };
}

function validateReadSnapshot(snapshot) {
  requireString(snapshot.projectId, "snapshot project id");
  requireString(snapshot.projectName, "snapshot project name");
  requireString(snapshot.timeline?.id, "snapshot timeline id");
  requireString(snapshot.timeline?.name, "snapshot timeline name");
  requireFiniteNumber(snapshot.timeline?.duration, "timeline duration");
  assert(snapshot.timeline.duration >= 0, "timeline duration must be non-negative");
  validateReadRational(snapshot.timeline.durationTime, "timeline duration time");
  assertReadRationalMatches(snapshot.timeline.duration, snapshot.timeline.durationTime, "timeline duration");
  requireReadArray(snapshot.timeline.clips, "timeline clips");
  requireReadArray(snapshot.timeline.storyElements, "timeline story elements");
  requireReadArray(snapshot.timeline.markers, "timeline markers");
  requireReadArray(snapshot.timeline.captions, "timeline captions");
  requireReadArray(snapshot.media, "media references");
  summarizeRevision(snapshot.revision);

  const mediaIds = uniqueReadIds(snapshot.media, "media", (media) => {
    requireString(media.mediaId, "media id");
    requireString(media.source, `media ${media.mediaId} source`);
    if (media.duration !== undefined) {
      requireFiniteNumber(media.duration, `media ${media.mediaId} duration`);
      assert(media.duration >= 0, `media ${media.mediaId} duration must be non-negative`);
    }
    return media.mediaId;
  });
  const storyElementIds = uniqueReadIds(snapshot.timeline.storyElements, "story element", (element) => {
    requireString(element.id, "story element id");
    validateReadCoordinates(element, `story element ${element.id}`);
    if (element.lane !== undefined) assert(Number.isInteger(element.lane), `story element ${element.id} lane must be an integer`);
    if (element.mediaId !== undefined) assert(mediaIds.has(element.mediaId), `story element ${element.id} references missing media`);
    return element.id;
  });
  uniqueReadIds(snapshot.timeline.markers, "marker", (marker) => {
    requireString(marker.id, "marker id");
    requireString(marker.name, `marker ${marker.id} name`);
    validateReadCoordinates(marker, `marker ${marker.id}`);
    return marker.id;
  });
  uniqueReadIds(snapshot.timeline.captions, "caption", (caption) => {
    requireString(caption.id, "caption id");
    assert(typeof caption.text === "string", `caption ${caption.id} text must be a string`);
    validateReadCoordinates(caption, `caption ${caption.id}`);
    return caption.id;
  });
  uniqueReadIds(snapshot.timeline.clips, "timeline occurrence", (clip) => {
    requireString(clip.id, "occurrence id");
    requireString(clip.name, `occurrence ${clip.id} name`);
    assert(Number.isInteger(clip.track), `occurrence ${clip.id} track must be an integer`);
    validateReadCoordinates(clip, `occurrence ${clip.id}`);
    if (clip.mediaId !== undefined) assert(mediaIds.has(clip.mediaId), `occurrence ${clip.id} references missing media`);
    const storyElement = snapshot.timeline.storyElements.find(({ id }) => id === clip.id);
    assert(storyElementIds.has(clip.id) && storyElement, `occurrence ${clip.id} has no storyline relationship`);
    assert(storyElement.start === clip.start && storyElement.duration === clip.duration, `occurrence ${clip.id} does not match storyline coordinates`);
    return clip.id;
  });
  return snapshot;
}

function validateReadCoordinates(value, field) {
  requireFiniteNumber(value.start, `${field} start`);
  requireFiniteNumber(value.duration, `${field} duration`);
  assert(value.start >= 0, `${field} start must be non-negative`);
  assert(value.duration >= 0, `${field} duration must be non-negative`);
  validateReadRational(value.startTime, `${field} start time`);
  validateReadRational(value.durationTime, `${field} duration time`);
  assertReadRationalMatches(value.start, value.startTime, `${field} start`);
  assertReadRationalMatches(value.duration, value.durationTime, `${field} duration`);
}

function validateReadRational(value, field) {
  assert(value && /^-?\d+$/.test(value.value) && /^\d+$/.test(value.timescale), `${field} must use an integer value and positive timescale`);
  assert(BigInt(value.timescale) > 0n, `${field} must use a positive timescale`);
  const seconds = Number(value.value) / Number(value.timescale);
  assert(Number.isFinite(seconds), `${field} must represent a finite time`);
}

function assertReadRationalMatches(actual, rational, field) {
  const expected = Number(rational.value) / Number(rational.timescale);
  assert(Math.abs(actual - expected) <= Math.max(1e-9, Math.abs(actual) * 1e-12), `${field} time does not match seconds`);
}

function uniqueReadIds(values, kind, validate) {
  const ids = new Set();
  for (const value of values) {
    assert(value && typeof value === "object" && !Array.isArray(value), `${kind} must be an object`);
    const id = validate(value);
    assert(!ids.has(id), `duplicate ${kind} id ${id}`);
    ids.add(id);
  }
  return ids;
}

function requireReadArray(value, field) {
  assert(Array.isArray(value), `${field} must be an array`);
}

function sanitizeEnvironment(environment) {
  const gitCommit = requireString(environment?.gitCommit, "Git commit");
  assert(/^[0-9a-f]{40}$/i.test(gitCommit), "Git commit must be a full SHA-1");
  return {
    framekitVersion: requireString(environment?.framekitVersion, "Framekit version"),
    finalCutVersion: requireString(environment?.finalCutVersion, "Final Cut version"),
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
  const editor = pickKnown(capabilities.editor, editorCapabilityKeys);
  const analyzers = pickKnown(capabilities.analyzers, analyzerCapabilityKeys);
  assert(typeof editor.canonicalTimelineMode === "string", "canonicalTimelineMode capability must be a string");
  for (const key of editorCapabilityKeys.filter((key) => key !== "canonicalTimelineMode")) {
    if (editor[key] !== undefined) assert(typeof editor[key] === "boolean", `${key} capability must be boolean`);
  }
  for (const key of analyzerCapabilityKeys) {
    if (analyzers[key] !== undefined) assert(typeof analyzers[key] === "boolean", `${key} capability must be boolean`);
  }
  return {
    editor,
    analyzers,
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
    sequence: requireNonNegativeInteger(revision.sequence, "revision sequence"),
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

function requireFiniteNumber(value, label) {
  assert(typeof value === "number" && Number.isFinite(value), `${label} must be a finite number`);
  return value;
}

function requireNonNegativeInteger(value, label) {
  assert(Number.isInteger(value) && value >= 0, `${label} must be a non-negative integer`);
  return value;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function assert(condition, message) {
  if (!condition) throw new Error(`FINAL_CUT_E2E_EVIDENCE_INCOMPLETE: ${message}`);
}
