import { isDeepStrictEqual } from "node:util";
import { canonicalEvidenceDigest } from "./final-cut-evidence.mjs";

/** Preview exactly one rename, prove the preview did not mutate, then execute once. */
export async function previewAndExecuteCanonicalRename(callJson, readTarget, before, clipId, name) {
  const fail = () => { throw new Error("FINAL_CUT_E2E_PREVIEW_MISMATCH: preview or subsequent observation differs from the approved rename"); };
  const operation = { type: "rename-clip", clipId, name };
  const preview = await callJson("editor.timeline.edit.preview", {
    projectId: before.projectId, sequenceId: before.timeline.id, baseRevision: before.revision,
    operations: [operation], path: "headed",
  });
  const revisionMatches = (left, right) => left?.id === right?.id && left?.sequence === right?.sequence && left?.timestamp === right?.timestamp;
  const matches = before.timeline.clips.filter((clip) => clip.id === clipId);
  const diff = preview?.expectedDiff;
  const change = diff?.modified?.[0];
  const expectedClip = matches[0] && { ...matches[0], name };
  if (matches.length !== 1 || typeof preview?.previewToken !== "string" || !preview.previewToken
    || preview.target?.kind !== "editor.timeline" || preview.target.projectId !== before.projectId
    || preview.target.sequenceId !== before.timeline.id || !revisionMatches(preview.baseRevision, before.revision)
    || !isDeepStrictEqual(preview.operations, [operation]) || !Array.isArray(preview.warnings) || preview.warnings.length !== 0
    || !Array.isArray(diff?.added) || diff.added.length || !Array.isArray(diff.removed) || diff.removed.length
    || !Array.isArray(diff.modified) || diff.modified.length !== 1 || change.itemId !== clipId
    || !isDeepStrictEqual(change.before, matches[0]) || !isDeepStrictEqual(change.after, expectedClip)
    || diff.durationDelta !== 0 || diff.playheadChange
    || ["markerChanges", "captionChanges", "storyElementChanges", "mediaChanges"].some((key) => !Array.isArray(diff[key]) || diff[key].length)) fail();
  const afterPreview = await readTarget();
  if (!revisionMatches(afterPreview?.revision, before.revision) || canonicalEvidenceDigest(afterPreview) !== canonicalEvidenceDigest(before)) fail();
  return callJson("editor.timeline.edit.execute", { previewToken: preview.previewToken, path: "headed" });
}
