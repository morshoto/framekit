import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const required = ["reviewed-removal", "protected-speech", "uncertain-candidates", "repeated-source", "fractional-multiple-cuts",
  "no-candidates", "invalid-selection", "stale-preview", "expired-preview", "reused-token", "missing-vad", "verification-recovery"];
const changing = new Set(["reviewed-removal", "protected-speech", "repeated-source", "fractional-multiple-cuts", "verification-recovery"]);
const check = (condition, message) => assert.ok(condition, `filler acceptance: ${message}`);
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const identity = value => typeof value === "string" && /^[\w.:+-]{1,200}$/.test(value);
const sha256 = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const equal = (left, right) => { try { assert.deepEqual(left, right); return true; } catch { return false; } };
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value?.[key]]));
const targetKeys = ["projectId", "sequenceId", "occurrenceId"];

/** Validate persisted observations, not truthy status flags or source transcripts. */
export function validateFillerNativeAcceptance(run) {
  const acceptance = run?.acceptance;
  const commit = run?.environment?.gitCommit;
  check(run?.schemaVersion === 2 && /^[a-f0-9]{40}$/.test(commit ?? "") && acceptance?.candidateCommit === commit, "candidate-bound schema v2 is required");
  check(run?.editor?.backend === "final-cut-live", "production editor identity is required");
  const capabilities = run.capabilities;
  check(capabilities?.editor?.canonicalTimelineMode === "canonical-write"
    && ["timelineSnapshotRead", "timelineWrite", "compositeTransactions", "readAfterWrite", "rollback"].every(key => capabilities.editor[key] === true)
    && capabilities.editor.semanticOperations?.["ripple-delete"] === true
    && capabilities.analyzers?.speechTranscribe === true && capabilities.analyzers?.speechVad === true, "required native capabilities are unavailable");
  const names = ["package", "plugin", "workflow-extension", "speech-provider"];
  check(Array.isArray(acceptance.components) && acceptance.components.length === names.length, "loaded component identities are missing");
  const components = acceptance.components.map(item => {
    check(names.includes(item.name) && identity(item.version) && /^[a-f0-9]{40}$/.test(item.expectedCommit ?? "")
      && (item.name === "speech-provider" || item.expectedCommit === commit)
      && item.observedCommit === item.expectedCommit && digest(item.artifactDigest), "loaded component differs from the candidate");
    return pick(item, ["name", "version", "expectedCommit", "observedCommit", "artifactDigest"]);
  });
  check(new Set(components.map(item => item.name)).size === names.length, "component identities are duplicated");
  check(Array.isArray(acceptance.scenarios) && acceptance.scenarios.length === required.length
    && required.every(id => acceptance.scenarios.filter(item => item.id === id).length === 1), "required native scenarios are missing or duplicated");
  const scenarios = acceptance.scenarios.map(item => validateScenario(item, commit));
  const reviewed = scenarios.find(item => item.id === "reviewed-removal");
  check(run.project?.id === reviewed.target.projectId && run.project?.sequenceId === reviewed.target.sequenceId
    && run.project?.occurrenceId === reviewed.target.occurrenceId
    && (run.revisions?.before ?? run.removal?.beforeRevision?.id) === reviewed.before.revision.id
    && (run.revisions?.after ?? run.removal?.afterRevision?.id) === reviewed.after.revision.id
    && (run.revisions?.restored ?? run.restoration?.restoredRevision?.id) === reviewed.restored.revision.id
    && run.restoration?.beforeDigest === reviewed.before.digest && run.restoration?.restoredDigest === reviewed.restored.digest,
  "summary target, revisions or restoration differs from the reviewed scenario");
  const removedFrames = reviewed.reference.expectedCuts.reduce((sum, cut) => sum + cut.endFrame - cut.startFrame, 0);
  const duration = removedFrames * Number(reviewed.reference.frameDuration.value) / Number(reviewed.reference.frameDuration.timescale);
  check(run.removal?.operationCount === reviewed.reference.expectedCuts.length && Number.isFinite(run.removal?.removedDurationSeconds)
    && Math.abs(run.removal.removedDurationSeconds - duration) <= 1e-9, "summary duration differs from approved cut frames");
  return { candidateCommit: commit, components, scenarios };
}

function validateScenario(item, commit) {
  const target = pick(item.target, targetKeys);
  check(targetKeys.every(key => identity(target[key])), `${item.id}: stable target is missing`);
  const changes = changing.has(item.id);
  const outcome = item.id === "verification-recovery" ? "recovered" : changes ? "verified"
    : ["no-candidates", "uncertain-candidates"].includes(item.id) ? "no-op" : "rejected";
  check(item.outcome === outcome, `${item.id}: unexpected outcome`);
  const phases = Object.fromEntries(["before", "after", "restored"].map(phase => {
    const state = item[phase];
    check(digest(state?.digest) && digest(state?.semanticDigest) && identity(state?.revision?.id) && Number.isSafeInteger(state.revision.sequence)
      && state.revision.sequence >= 0 && Number.isFinite(Date.parse(state.revision.timestamp)), `${item.id}: ${phase} observation is incomplete`);
    return [phase, { digest: state.digest, semanticDigest: state.semanticDigest, revision: pick(state.revision, ["id", "sequence", "timestamp"]) }];
  }));
  const { before, after, restored } = phases;
  check(before.digest === restored.digest && before.semanticDigest === restored.semanticDigest, `${item.id}: restoration digest differs`);
  check(changes ? before.digest !== after.digest && before.revision.sequence < after.revision.sequence
    && after.revision.sequence < restored.revision.sequence && new Set([before.revision.id, after.revision.id, restored.revision.id]).size === 3
    : equal(before, after) && equal(before, restored), `${item.id}: revision or non-mutation proof differs`);
  const reference = item.reference;
  const frame = reference?.frameDuration;
  check(/^[1-9]\d*$/.test(frame?.value ?? "") && /^[1-9]\d*$/.test(frame?.timescale ?? ""), `${item.id}: exact frame duration is missing`);
  const cuts = validateRanges(reference.expectedCuts, true);
  const protectedRanges = validateRanges(reference.protectedRanges, false);
  check(digest(reference.expectedAfterDigest) && reference.expectedAfterDigest === after.semanticDigest
    && digest(reference.expectedContentDigest), `${item.id}: independent semantic reference differs`);
  check(changes ? cuts.length > 0 : cuts.length === 0, `${item.id}: expected cut set differs`);
  if (item.id === "fractional-multiple-cuts") check(cuts.length >= 2 && BigInt(frame.value) > 1n, "fractional multiple-cut scenario is incomplete");
  if (item.id === "protected-speech") check(protectedRanges.length > 0, "protected speech reference is missing");
  check(cuts.every(cut => !protectedRanges.some(protectedRange => cut.occurrenceId === protectedRange.occurrenceId
    && cut.startFrame < protectedRange.endFrame && cut.endFrame > protectedRange.startFrame)), `${item.id}: a cut overlaps protected speech`);
  check(cuts.every((cut, index) => !cuts.slice(index + 1).some(other => cut.occurrenceId === other.occurrenceId
    && cut.startFrame < other.endFrame && cut.endFrame > other.startFrame)), `${item.id}: cuts overlap`);
  const safeReference = { frameDuration: pick(frame, ["value", "timescale"]), expectedCuts: cuts, protectedRanges,
    expectedAfterDigest: reference.expectedAfterDigest, expectedContentDigest: reference.expectedContentDigest };
  if (item.id === "repeated-source") {
    const reused = reference.reusedSource;
    check(identity(reused?.mediaId) && digest(reused?.sourceDigest) && reused.selectedOccurrenceId === target.occurrenceId
      && identity(reused.untouchedOccurrenceId) && reused.untouchedOccurrenceId !== target.occurrenceId
      && digest(reused.expectedUntouchedDigest), "repeated source reference is incomplete");
    safeReference.reusedSource = pick(reused, ["mediaId", "sourceDigest", "selectedOccurrenceId", "untouchedOccurrenceId", "expectedUntouchedDigest"]);
  }
  const approval = item.approval;
  const operations = ["preview", "execute", "verify", "undo"];
  check(approval?.candidateCommit === commit && targetKeys.every(key => approval[key] === target[key])
    && approval.beforeRevisionId === before.revision.id && approval.referenceDigest === sha256(safeReference)
    && equal(approval.operations, operations), `${item.id}: approval is not bound to the reference and baseline`);
  const review = item.review;
  for (const key of ["suggestedCandidateIds", "approvedCandidateIds", "selectedCandidateIds"]) {
    check(Array.isArray(review?.[key]) && review[key].every(identity) && new Set(review[key]).size === review[key].length, `${item.id}: candidate review is malformed`);
  }
  if (item.id === "no-candidates") check(review.suggestedCandidateIds.length === 0, "no-candidate scenario contains candidates");
  if (item.id === "uncertain-candidates") check(review.suggestedCandidateIds.length > 0, "uncertain-candidate scenario has no reviewed candidates");
  const ids = cuts.map(cut => cut.candidateId).sort();
  check(equal([...review.approvedCandidateIds].sort(), ids) && equal([...review.selectedCandidateIds].sort(), ids)
    && ids.every(id => review.suggestedCandidateIds.includes(id))
    && equal(validateRanges(review.approvedCuts, true), cuts) && equal(validateRanges(review.executedCuts, true), cuts)
    && review.firstPreviewDigest === before.digest && review.selectedPreviewDigest === before.digest
    && digest(review.approvedPreviewDigest) && review.approvedPreviewDigest === review.executedPreviewDigest,
  `${item.id}: reviewed preview or executed cuts differ from approval`);
  const sourceIntegrity = Object.fromEntries(["before", "after", "restored"].map(phase => {
    const sources = item.sourceIntegrity?.[phase];
    check(Array.isArray(sources) && sources.length > 0 && sources.every(source => identity(source.mediaId) && digest(source.digest))
      && new Set(sources.map(source => source.mediaId)).size === sources.length, `${item.id}: source integrity is incomplete`);
    return [phase, sources.map(source => pick(source, ["mediaId", "digest"])).sort((a, b) => a.mediaId.localeCompare(b.mediaId))];
  }));
  check(equal(sourceIntegrity.before, sourceIntegrity.after) && equal(sourceIntegrity.before, sourceIntegrity.restored), `${item.id}: source media changed`);
  let reusedSourceReadback;
  if (safeReference.reusedSource) {
    const reused = safeReference.reusedSource;
    const observed = item.reusedSourceReadback;
    check(sourceIntegrity.before.some(source => source.mediaId === reused.mediaId && source.digest === reused.sourceDigest)
      && ["mediaId", "sourceDigest", "selectedOccurrenceId", "untouchedOccurrenceId"].every(key => observed?.[key] === reused[key])
      && ["beforeDigest", "afterDigest", "restoredDigest"].every(key => observed?.[key] === reused.expectedUntouchedDigest), "repeated source occurrence was not preserved");
    reusedSourceReadback = pick(observed, ["mediaId", "sourceDigest", "selectedOccurrenceId", "untouchedOccurrenceId", "beforeDigest", "afterDigest", "restoredDigest"]);
  }
  let editedSpeech;
  if (changes) {
    const signal = item.editedSpeech;
    check(signal?.scope === "edited-timeline-output" && targetKeys.every(key => signal[key] === target[key])
      && signal.revisionId === after.revision.id && signal.canonicalDigest === after.digest && digest(signal.outputDigest)
      && !sourceIntegrity.before.some(source => source.digest === signal.outputDigest)
      && identity(signal.provider?.id) && identity(signal.provider?.version) && digest(signal.observedContentDigest)
      && (outcome === "recovered" ? signal.observedContentDigest !== reference.expectedContentDigest
        : signal.observedContentDigest === reference.expectedContentDigest), `${item.id}: edited-speech continuity evidence is missing or mismatched`);
    editedSpeech = { ...pick(signal, ["scope", ...targetKeys, "revisionId", "canonicalDigest", "outputDigest", "observedContentDigest"]), provider: pick(signal.provider, ["id", "version"]) };
  }
  if (outcome === "recovered") check(item.failure?.code === "CONTINUITY_FAILED" && item.failure.restorationVerified === true, `${item.id}: failure recovery is not verified`);
  const rejectionCodes = { "invalid-selection": "CANDIDATE_NOT_FOUND", "stale-preview": "STALE_CONTEXT",
    "expired-preview": "SKILL_PREVIEW_TOKEN_EXPIRED", "reused-token": "SKILL_PREVIEW_TOKEN_INVALID", "missing-vad": "SKILL_REQUIREMENTS_UNMET" };
  if (outcome === "rejected") check(item.rejectionCode === rejectionCodes[item.id], `${item.id}: expected rejection outcome is missing`);
  return { id: item.id, target, outcome, ...phases, reference: safeReference,
    approval: { candidateCommit: commit, ...target, beforeRevisionId: before.revision.id, referenceDigest: approval.referenceDigest, operations },
    review: { ...pick(review, ["suggestedCandidateIds", "approvedCandidateIds", "selectedCandidateIds", "firstPreviewDigest", "selectedPreviewDigest", "approvedPreviewDigest", "executedPreviewDigest"]), approvedCuts: cuts, executedCuts: cuts },
    sourceIntegrity, ...(editedSpeech ? { editedSpeech } : {}), ...(reusedSourceReadback ? { reusedSourceReadback } : {}),
    ...(outcome === "recovered" ? { failure: pick(item.failure, ["code", "restorationVerified"]) } : {}),
    ...(outcome === "rejected" ? { rejectionCode: item.rejectionCode } : {}) };
}

function validateRanges(ranges, candidates) {
  check(Array.isArray(ranges), "exact frame ranges are missing");
  return ranges.map(range => {
    check(identity(range.occurrenceId) && (!candidates || identity(range.candidateId))
      && Number.isSafeInteger(range.startFrame) && range.startFrame >= 0 && Number.isSafeInteger(range.endFrame)
      && range.endFrame > range.startFrame, "frame range is invalid");
    return pick(range, [...(candidates ? ["candidateId"] : []), "occurrenceId", "startFrame", "endFrame"]);
  });
}

/** Source/range/order projection deliberately excludes newly assigned clip IDs. */
export function fillerTimelineSemanticDigest(snapshot) {
  check(Array.isArray(snapshot?.timeline?.clips), "canonical source-range readback is unavailable");
  const time = value => {
    check(/^-?\d+$/.test(value?.value ?? "") && /^[1-9]\d*$/.test(value?.timescale ?? ""), "exact source-range readback is unavailable");
    let n = BigInt(value.value); let d = BigInt(value.timescale);
    let a = n < 0n ? -n : n; let b = d;
    while (b) [a, b] = [b, a % b];
    return `${n / a}/${d / a}`;
  };
  const projection = { frameDuration: time(snapshot.timeline.frameDuration), duration: time(snapshot.timeline.durationTime),
    clips: snapshot.timeline.clips.map(clip => {
      check(identity(clip.mediaId) && Number.isFinite(clip.track) && Number.isFinite(clip.gainDb ?? 0), "source identity, gain or lane readback is unavailable");
      const { id, start, duration, sourceStart, startTime, durationTime, sourceStartTime, ...properties } = clip;
      return { ...properties, startTime: time(startTime), durationTime: time(durationTime), sourceStartTime: time(sourceStartTime) };
    }), storyElements: snapshot.timeline.storyElements ?? [], markers: snapshot.timeline.markers ?? [], captions: snapshot.timeline.captions ?? [] };
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  return sha256(stable(projection));
}
