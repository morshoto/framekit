import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

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
  "artifactPublish",
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
  ["project.list", "passed"],
  ["project.select", "passed"],
  ["project.inspect", "passed"],
  ["editor.timeline.edit", "VERIFIED"],
  ["edit.undo", "passed"],
];
const requiredDisposableToolResults = [
  ["editor.inspect", "passed"],
  ["project.inspect", "passed"],
  ["editor.native.disposable.preview", "passed"],
  ["editor.native.disposable.execute", "VERIFIED"],
  ["editor.native.disposable.undo", "passed"],
];
const nativeCapabilityKeys = [
  "selectionEdit",
  "undo",
  "mediaLibrarySearch",
  "mediaImport",
  "mediaSelection",
  "mediaAppendSelected",
  "timelineOccurrenceLocate",
  "bladeAtPlayhead",
  "deleteRange",
  "trimToDuration",
  "mediaAppend",
  "mediaInsert",
  "titleDiscovery",
  "titlePlacement",
  "timelineFocus",
  "requiresAccessibility",
  "requiresFinalCutFrontmost",
];

export async function evidenceEnvironment(root) {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  let gitCommit;
  try {
    gitCommit = (await execFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  } catch (error) {
    throw new Error(`FINAL_CUT_E2E_COMMIT_UNAVAILABLE: ${String(error)}`);
  }
  if (!/^[0-9a-f]{40}$/i.test(gitCommit)) {
    throw new Error("FINAL_CUT_E2E_COMMIT_UNAVAILABLE: git returned an invalid commit");
  }
  let finalCutVersion;
  try {
    finalCutVersion = (await execFile("osascript", ["-e", 'tell application "Final Cut Pro" to get version'])).stdout.trim();
  } catch (error) {
    throw new Error(`FINAL_CUT_E2E_FINAL_CUT_VERSION_UNAVAILABLE: ${String(error)}`);
  }
  if (!finalCutVersion) throw new Error("FINAL_CUT_E2E_FINAL_CUT_VERSION_UNAVAILABLE: Final Cut Pro returned an empty version");
  return {
    framekitVersion: packageJson.version,
    finalCutVersion,
    gitCommit,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    osVersion: os.version(),
  };
}

export function sanitizeCanonicalEvidence(run, environment) {
  assert(run?.passed === true, "headed run did not pass");
  assert(run.editStatus === "VERIFIED", "headed mutation was not verified");
  assert(run.editor, "editor identity is missing");
  assert(run.capabilities, "capability payload is missing");
  assert(run.capabilities.editor?.canonicalTimelineMode === "canonical-write", "canonical-write capability is required");
  assert(run.project && run.target, "project or target identity is missing");
  assert(run.before && run.after && run.restored && run.diff, "canonical snapshots or diff are missing");
  assert(run.digests?.before && run.digests?.restored, "canonical digests are missing");
  const beforeDigest = requireSha256Digest(run.digests.before, "before digest");
  const restoredDigest = requireSha256Digest(run.digests.restored, "restored digest");
  assert(beforeDigest === restoredDigest, "restored digest does not match the pre-edit digest");
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
      beforeDigest,
      restoredDigest,
      restoredRevision,
    },
    sanitization: {
      strategy: "allowlisted-summary",
      omitted: ["media sources", "raw snapshots", "transaction identifiers", "diagnostics"],
    },
  };
}

export function sanitizeDisposableNativeEvidence(run, environment) {
  assert(run?.passed === true, "headed run did not pass");
  assert(run.executeStatus === "VERIFIED", "disposable native mutation was not verified");
  assert(run.editor, "editor identity is missing");
  assert(run.capabilities, "capability payload is missing");
  const canonicalMode = run.capabilities.editor?.canonicalTimelineMode;
  assert(canonicalMode === "canonical-read" || canonicalMode === "canonical-write", "canonical live capability is required");
  for (const key of ["projectRead", "timelineSnapshotRead", "readAfterWrite", "projectCatalogRead", "projectSelection"]) {
    assert(run.capabilities.editor?.[key] === true, `${key} capability is required`);
  }
  assert(run.project && run.target, "project or target identity is missing");
  assert(run.before && run.after && run.restored && run.diff, "canonical snapshots or diff are missing");
  assert(run.digests?.before && run.digests?.after && run.digests?.restored, "canonical digests are missing");
  assert(run.digests.before !== run.digests.after, "canonical mutation did not change the pre-edit digest");
  assert(run.digests.before === run.digests.restored, "restored digest does not match the pre-edit digest");
  assert(run.restoredVerification?.passed === true, "canonical restoration was not verified");

  const beforeRevision = summarizeRevision(run.before.revision);
  const afterRevision = summarizeRevision(run.after.revision);
  const restoredRevision = summarizeRevision(run.restored.revision);
  assert(afterRevision.sequence > beforeRevision.sequence, "canonical mutation revision did not advance");
  assert(restoredRevision.sequence > afterRevision.sequence, "canonical restoration revision did not advance");

  const beforeTarget = findTarget(run.before, run.target.occurrenceId);
  const afterTarget = findTarget(run.after, run.target.occurrenceId);
  const restoredTarget = findTarget(run.restored, run.target.occurrenceId);
  assert(beforeTarget && afterTarget && restoredTarget, "target occurrence is missing from a canonical snapshot");
  assert(beforeTarget.name !== afterTarget.name, "canonical mutation did not change the target occurrence");
  assert(beforeTarget.name === restoredTarget.name, "restored target occurrence does not match the pre-edit state");

  const modified = Array.isArray(run.diff.modified) ? run.diff.modified : [];
  const modifiedItemIds = modified.map((change) => change?.itemId).filter(isNonEmptyString);
  assert(countChanges(run.diff.added) === 0 && countChanges(run.diff.removed) === 0, "disposable diff contains unexpected additions or removals");
  assert(modified.length === 1 && modifiedItemIds.length === 1 && modifiedItemIds[0] === run.target.occurrenceId, "disposable diff does not identify exactly the target occurrence");

  return {
    schemaVersion: 1,
    evidenceType: "headed-native-disposable-mutation",
    passed: true,
    recordedAt: requireString(run.recordedAt, "recordedAt"),
    environment: sanitizeEnvironment(environment),
    editor: sanitizeIdentity(run.editor),
    capabilities: sanitizeCapabilities(run.capabilities),
    nativeCapabilities: sanitizeNativeCapabilities(run.nativeCapabilities),
    project: {
      id: requireString(run.project.id, "project id"),
      name: requireString(run.project.name, "project name"),
      sequenceId: requireString(run.project.sequenceId, "sequence id"),
    },
    target: {
      occurrenceId: requireString(run.target.occurrenceId, "occurrence id"),
      ...(isNonEmptyString(run.target.mediaId) ? { mediaId: run.target.mediaId } : {}),
    },
    toolResults: sanitizeToolResultsFor(run.toolResults, requiredDisposableToolResults),
    mutation: {
      operation: "rename-selected-clip",
      status: run.executeStatus,
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
      operation: "editor.native.disposable.undo",
      status: "VERIFIED",
      restored: true,
      beforeDigest: run.digests.before,
      restoredDigest: run.digests.restored,
      restoredRevision,
    },
    sanitization: {
      strategy: "allowlisted-summary",
      omitted: ["media sources", "raw snapshots", "operation identifiers", "diagnostics"],
    },
  };
}

export function sanitizePictureInPictureEvidence(run, environment) {
  assert(run?.passed === true, "headed picture-in-picture run did not pass");
  assert(run.editor, "editor identity is missing");
  assert(run.target && run.placement, "picture-in-picture target or placement is missing");
  const target = {
    project: requireString(run.target.project ?? run.placement.project, "picture-in-picture project"),
    sequenceId: requireString(run.target.sequenceId, "picture-in-picture sequence id"),
    occurrenceId: requireString(run.target.occurrenceId, "picture-in-picture occurrence id"),
    ...(isNonEmptyString(run.target.occurrenceName) ? { occurrenceName: run.target.occurrenceName } : {}),
    ...(isNonEmptyString(run.target.start) ? { start: run.target.start } : {}),
    ...(isNonEmptyString(run.target.duration) ? { duration: run.target.duration } : {}),
  };
  const revisions = summarizeWorkflowRevisions(run.placement, "picture-in-picture");
  assert(run.placement.observed, "picture-in-picture readback is missing");
  assert(run.placement.undoVerified?.verified === true || run.placement.undo?.verified === true, "picture-in-picture Undo verification is missing");
  return {
    schemaVersion: 1,
    evidenceType: "headed-native-picture-in-picture",
    passed: true,
    recordedAt: requireString(run.recordedAt, "recordedAt"),
    environment: sanitizeEnvironment(environment),
    editor: sanitizeIdentity(run.editor),
    capabilities: sanitizeBooleanCapabilities(run.capabilities, ["nativePictureInPicture", "nativeUndo", "nativeTimelineOccurrenceLocate"]),
    target,
    placement: {
      requested: sanitizePictureInPictureProperties(run.placement.requested ?? run.placement),
      observed: sanitizePictureInPictureProperties(run.placement.observed),
    },
    revisions,
    verification: { execute: true, undo: true },
    ...(run.toolResults ? { toolResults: sanitizeToolResultList(run.toolResults) } : {}),
    sanitization: {
      strategy: "allowlisted-summary",
      omitted: ["media sources", "native handles", "operation identifiers", "raw diagnostics"],
    },
  };
}

export function sanitizeNativeTitleEvidence(run, environment) {
  assert(run?.passed === true, "headed title run did not pass");
  assert(run.discovery && run.placement, "title discovery or placement is missing");
  assert(run.target, "title target is missing");
  assert(run.placement.verified === true, "native title placement was not verified");
  assert(run.placement.undo?.verified === true, "native title Undo verification is missing");
  const assetId = requireSafeIdentity(run.discovery.id, "native title asset id");
  assert(assetId.startsWith("final-cut:title:"), "native title asset must be provider-qualified");
  const target = {
    project: requireString(run.project ?? run.target.project, "native title project"),
    sequenceId: requireString(run.target.sequenceId, "native title sequence id"),
  };
  return {
    schemaVersion: 1,
    evidenceType: "headed-native-title-discovery-and-placement",
    passed: true,
    recordedAt: requireString(run.recordedAt, "recordedAt"),
    environment: sanitizeEnvironment(environment),
    target,
    discovery: {
      assetId,
      name: requireString(run.discovery.name, "native title name"),
      vendor: requireString(run.discovery.vendor, "native title vendor"),
      backend: requireString(run.discovery.backend, "native title discovery backend"),
      guarantee: requireString(run.discovery.guarantee, "native title discovery guarantee"),
    },
    placement: {
      text: requireString(run.placement.text, "native title text"),
      target: requireString(run.placement.target, "native title placement target"),
      start: sanitizeRational(run.placement.start, "native title start"),
      duration: sanitizeRational(run.placement.duration, "native title duration"),
    },
    revisions: summarizeWorkflowRevisions(run.placement, "native title"),
    verification: { execute: true, undo: true },
    ...(run.toolResults ? { toolResults: sanitizeToolResultList(run.toolResults) } : {}),
    sanitization: {
      strategy: "allowlisted-summary",
      omitted: ["native handles", "operation identifiers", "raw diagnostics"],
    },
  };
}

export function sanitizeMaskEvidence(run, environment) {
  assert(run?.passed === true, "headed masking run did not pass");
  assert(run.target && run.mask, "mask target or configuration is missing");
  assert(run.verification?.execute?.verified === true, "native mask placement was not verified");
  assert(run.verification?.undo?.verified === true, "native mask Undo verification is missing");
  const target = {
    project: requireString(run.project ?? run.target.project, "native mask project"),
    sequenceId: requireString(run.target.sequenceId, "native mask sequence id"),
    occurrenceId: requireString(run.target.occurrenceId, "native mask occurrence id"),
    ...(isNonEmptyString(run.target.occurrenceName) ? { occurrenceName: run.target.occurrenceName } : {}),
    ...(isNonEmptyString(run.target.start) ? { start: run.target.start } : {}),
    ...(isNonEmptyString(run.target.duration) ? { duration: run.target.duration } : {}),
  };
  return {
    schemaVersion: 1,
    evidenceType: "headed-native-mask-placement",
    passed: true,
    recordedAt: requireString(run.recordedAt, "recordedAt"),
    environment: sanitizeEnvironment(environment),
    target,
    mask: {
      requested: sanitizeMaskConfiguration(run.mask.requested, "requested mask"),
      observed: sanitizeMaskConfiguration(run.mask.observed, "observed mask"),
    },
    revisions: summarizeWorkflowRevisions(run.revisions ?? run, "native mask"),
    verification: { execute: true, undo: true },
    ...(run.toolResults ? { toolResults: sanitizeToolResultList(run.toolResults) } : {}),
    sanitization: {
      strategy: "allowlisted-summary",
      omitted: ["raw native contexts", "media paths", "native handles", "operation identifiers", "raw diagnostics"],
    },
  };
}

export function sanitizeFillerRemovalEvidence(run, environment) {
  assert(run?.passed === true, "headed filler-removal run did not pass");
  assert(run.editor && run.project && run.removal && run.restoration, "filler-removal evidence is incomplete");
  assert(run.removal.status === "VERIFIED", "filler-removal mutation was not verified");
  assert(run.removal.continuityVerified === true, "filler-removal continuity was not verified");
  assert(run.restoration.restored === true && run.restoration.status === "VERIFIED", "filler-removal Undo was not verified");
  const project = {
    id: requireString(run.project.id, "filler-removal project id"),
    name: requireString(run.project.name, "filler-removal project name"),
    sequenceId: requireString(run.project.sequenceId, "filler-removal sequence id"),
  };
  const revisions = {
    before: requireString(run.removal.beforeRevision?.id, "filler-removal before revision"),
    after: requireString(run.removal.afterRevision?.id, "filler-removal after revision"),
    restored: requireString(run.restoration.restoredRevision?.id, "filler-removal restored revision"),
  };
  assert(revisions.before !== revisions.after, "filler-removal revision did not advance");
  return {
    schemaVersion: 1,
    evidenceType: "headed-native-filler-removal",
    passed: true,
    recordedAt: requireString(run.recordedAt, "recordedAt"),
    environment: sanitizeEnvironment(environment),
    editor: sanitizeIdentity(run.editor),
    capabilities: sanitizeCapabilities(run.capabilities),
    project,
    target: { project: project.name, projectId: project.id, sequenceId: project.sequenceId },
    selection: {
      start: requireFiniteNumber(run.selection.start, "filler-removal selection start"),
      end: requireFiniteNumber(run.selection.end, "filler-removal selection end"),
    },
    removal: {
      status: run.removal.status,
      candidateCount: requireNonNegativeInteger(run.removal.candidateCount, "filler-removal candidate count"),
      operationCount: requireNonNegativeInteger(run.removal.operationCount, "filler-removal operation count"),
      removedDurationSeconds: requireFiniteNumber(run.removal.removedDurationSeconds, "filler-removal duration"),
      affectedRangeCount: requireNonNegativeInteger(run.removal.affectedRangeCount, "filler-removal affected range count"),
      continuityVerified: run.removal.continuityVerified === true,
    },
    revisions,
    restoration: { status: "VERIFIED", restored: true },
    verification: { execute: true, undo: true },
    toolResults: sanitizeToolResultList(run.toolResults),
    sanitization: {
      strategy: "allowlisted-summary",
      omitted: ["media sources", "raw snapshots", "transaction identifiers", "raw diagnostics"],
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
  const storyElementsById = new Map();
  uniqueReadIds(snapshot.timeline.storyElements, "story element", (element) => {
    requireString(element.id, "story element id");
    validateReadCoordinates(element, `story element ${element.id}`);
    if (element.lane !== undefined) assert(Number.isInteger(element.lane), `story element ${element.id} lane must be an integer`);
    if (element.mediaId !== undefined) assert(mediaIds.has(element.mediaId), `story element ${element.id} references missing media`);
    storyElementsById.set(element.id, element);
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
    const storyElement = storyElementsById.get(clip.id);
    assert(storyElement, `occurrence ${clip.id} has no storyline relationship`);
    assert(storyElement.start === clip.start && storyElement.duration === clip.duration, `occurrence ${clip.id} does not match storyline coordinates`);
    return clip.id;
  });
  return snapshot;
}

function summarizeWorkflowRevisions(value, label) {
  const before = requireString(revisionIdentity(value.before ?? value.beforeRevision), `${label} before revision`);
  const after = requireString(revisionIdentity(value.after ?? value.afterRevision), `${label} after revision`);
  const restored = requireString(revisionIdentity(value.restored ?? value.restoredRevision ?? value.undoRevision), `${label} restored revision`);
  assert(before !== after, `${label} revision did not advance`);
  return {
    before,
    after,
    restored,
  };
}

function revisionIdentity(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.id === "string") return value.id;
  return undefined;
}

function sanitizeBooleanCapabilities(value, keys) {
  const result = {};
  for (const key of keys) {
    if (value?.[key] !== undefined) assert(typeof value[key] === "boolean", `${key} capability must be boolean`);
    if (value?.[key] !== undefined) result[key] = value[key];
  }
  return result;
}

function sanitizePictureInPictureProperties(value) {
  assert(value && typeof value === "object" && !Array.isArray(value), "picture-in-picture properties are missing");
  const result = {};
  if (value.start !== undefined) result.start = sanitizeRational(value.start, "picture-in-picture start");
  if (value.duration !== undefined) result.duration = sanitizeRational(value.duration, "picture-in-picture duration");
  if (value.position !== undefined) {
    assertFiniteNumber(value.position.x, "picture-in-picture position x");
    assertFiniteNumber(value.position.y, "picture-in-picture position y");
    result.position = { x: value.position.x, y: value.position.y };
  }
  if (value.scale !== undefined) {
    assertFiniteNumber(value.scale, "picture-in-picture scale");
    result.scale = value.scale;
  }
  if (value.frame !== undefined) {
    assert(value.frame && value.frame.style === "solid", "picture-in-picture frame style must be solid");
    assert(typeof value.frame.color === "string" && /^#[0-9a-f]{6}$/i.test(value.frame.color), "picture-in-picture frame color is invalid");
    assertFiniteNumber(value.frame.width, "picture-in-picture frame width");
    result.frame = { style: "solid", color: value.frame.color.toUpperCase(), width: value.frame.width };
  }
  if (value.crop !== undefined) result.crop = sanitizeCrop(value.crop);
  assert(Object.keys(result).length > 0, "picture-in-picture properties are empty");
  return result;
}

function sanitizeMaskConfiguration(value, label) {
  assert(value?.mode === "rectangle", `${label} mode must be rectangle`);
  return { mode: "rectangle", bounds: sanitizeBounds(value.bounds, `${label} bounds`) };
}

function sanitizeCrop(value) {
  assert(value && typeof value === "object", "picture-in-picture crop is missing");
  const crop = { top: value.top, right: value.right, bottom: value.bottom, left: value.left };
  for (const [key, child] of Object.entries(crop)) assertFiniteNumber(child, `picture-in-picture crop ${key}`);
  return crop;
}

function sanitizeBounds(value, label) {
  assert(value && typeof value === "object", `${label} is missing`);
  const bounds = { x: value.x, y: value.y, width: value.width, height: value.height };
  for (const [key, child] of Object.entries(bounds)) assertFiniteNumber(child, `${label} ${key}`);
  return bounds;
}

function sanitizeRational(value, label) {
  if (typeof value === "string") {
    assert(/^\d+\/\d+$/.test(value), `${label} must use rational value/timescale form`);
    return value;
  }
  assert(value && /^\d+$/.test(value.value) && /^\d+$/.test(value.timescale) && BigInt(value.timescale) > 0n, `${label} must use rational value/timescale form`);
  return `${value.value}/${value.timescale}`;
}

function sanitizeToolResultList(value) {
  assert(Array.isArray(value) && value.length > 0, "tool results are missing");
  return value.map((result) => ({
    name: requireSafeIdentity(result?.name, "tool name"),
    status: requireSafeIdentity(result?.status, "tool status"),
  }));
}

function requireSafeIdentity(value, label) {
  const result = requireString(value, label);
  assert(!result.includes("/") && !result.includes("\\") && !result.startsWith("~"), `${label} must not be path-like`);
  return result;
}

function assertFiniteNumber(value, label) {
  assert(typeof value === "number" && Number.isFinite(value), `${label} must be a finite number`);
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

function sanitizeNativeCapabilities(capabilities) {
  assert(capabilities, "native capability payload is missing");
  const native = pickKnown(capabilities, nativeCapabilityKeys);
  for (const key of nativeCapabilityKeys) {
    if (native[key] !== undefined) assert(typeof native[key] === "boolean", `${key} native capability must be boolean`);
  }
  for (const key of ["selectionEdit", "undo", "timelineFocus"]) {
    assert(native[key] === true, `${key} native capability is required`);
  }
  return native;
}

function sanitizeToolResults(toolResults) {
  return sanitizeToolResultsFor(toolResults, requiredToolResults);
}

function sanitizeToolResultsFor(toolResults, expectedToolResults) {
  assert(Array.isArray(toolResults), "tool results are missing");
  assert(toolResults.length === expectedToolResults.length, "required tool results are incomplete");
  return toolResults.map((result, index) => {
    const [expectedName, expectedStatus] = expectedToolResults[index];
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

function requireSha256Digest(value, label) {
  assert(typeof value === "string" && /^[0-9a-f]{64}$/i.test(value), `${label} must be a 64-character SHA-256 hexadecimal string`);
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
