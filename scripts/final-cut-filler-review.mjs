import { isDeepStrictEqual } from "node:util";
import { canonicalEvidenceDigest } from "./final-cut-evidence.mjs";

export function parseFillerApproval(env) {
  const required = ["PROJECT", "PROJECT_ID", "SEQUENCE_ID", "REVISION_ID", "OCCURRENCE"];
  const get = key => env[`FRAMEKIT_FINAL_CUT_E2E_${key}`];
  const invalid = () => new Error("FILLER_APPROVAL_REQUIRED: supply mutation consent, exact candidate/target/revision and approved frame cuts");
  if (get("ALLOW_MUTATION") !== "1" || !/^[a-f0-9]{40}$/.test(get("CANDIDATE_COMMIT") ?? "")
    || required.some(key => typeof get(key) !== "string" || !get(key).trim())) throw invalid();
  let cuts;
  try { cuts = JSON.parse(get("APPROVED_CUTS") ?? ""); } catch { throw invalid(); }
  if (!Array.isArray(cuts) || !cuts.length || cuts.some(cut => typeof cut.candidateId !== "string" || !cut.candidateId.trim()
    || !Number.isSafeInteger(cut.startFrame) || cut.startFrame < 0 || !Number.isSafeInteger(cut.endFrame) || cut.endFrame <= cut.startFrame)
    || new Set(cuts.map(cut => cut.candidateId)).size !== cuts.length) throw invalid();
  if (cuts.some((cut, index) => cuts.slice(index + 1).some(other => cut.startFrame < other.endFrame && cut.endFrame > other.startFrame))) throw invalid();
  const start = Number(get("RANGE_START")); const end = Number(get("RANGE_END"));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw invalid();
  return { projectName: get("PROJECT"), projectId: get("PROJECT_ID"), sequenceId: get("SEQUENCE_ID"), revisionId: get("REVISION_ID"),
    occurrenceId: get("OCCURRENCE"), candidateCommit: get("CANDIDATE_COMMIT"), range: { start, end }, cuts: structuredClone(cuts) };
}

/** Read/preview only; execution remains with the caller after all checks pass. */
export async function previewApprovedFiller(callJson, readProject, before, approval) {
  const fail = detail => { throw new Error(`FILLER_REVIEW_REJECTED: ${detail}`); };
  if (before.projectId !== approval.projectId || before.timeline.id !== approval.sequenceId || before.projectName !== approval.projectName
    || before.revision.id !== approval.revisionId || approval.range.end > before.timeline.duration) fail("approved target or revision differs");
  const clips = before.timeline.clips.filter(clip => clip.id === approval.occurrenceId);
  if (clips.length !== 1 || !clips[0].mediaId) fail("approved occurrence is ambiguous");
  const clip = clips[0];
  const frame = before.timeline.frameDuration;
  if (!/^[1-9]\d*$/.test(frame?.value ?? "") || !/^[1-9]\d*$/.test(frame?.timescale ?? "")) fail("exact frame duration is unavailable");
  const frameSeconds = Number(frame.value) / Number(frame.timescale);
  if (!Number.isFinite(frameSeconds) || frameSeconds <= 0) fail("invalid timebase");
  const seconds = (time, fallback) => time ? Number(time.value) / Number(time.timescale) : fallback;
  const clipStart = seconds(clip.startTime, clip.start);
  const sourceStart = seconds(clip.sourceStartTime, clip.sourceStart ?? 0);
  const clipDuration = seconds(clip.durationTime, clip.duration);
  const baseline = canonicalEvidenceDigest(before);
  const unchanged = async () => {
    const current = await readProject();
    if (!isDeepStrictEqual(current.revision, before.revision) || canonicalEvidenceDigest(current) !== baseline) fail("preview mutated or lost the baseline");
  };
  const args = { baseRevision: before.revision, range: approval.range };
  const initial = await callJson("skill.preview", { skill: "filler-removal", arguments: args });
  await unchanged();
  const candidates = initial.plan?.details?.candidates;
  if (!Array.isArray(candidates) || approval.cuts.some(cut => candidates.filter(candidate => candidate.id === cut.candidateId
    && candidate.occurrenceId === clip.id && candidate.mediaId === clip.mediaId).length !== 1)) fail("approved candidates are absent or redirected");
  const selected = await callJson("skill.preview", { skill: "filler-removal", arguments: { ...args, selectedCandidateIds: approval.cuts.map(cut => cut.candidateId) } });
  await unchanged();
  if (!selected.previewToken || !Number.isFinite(Date.parse(selected.expiresAt)) || Date.parse(selected.expiresAt) <= Date.now()
    || !isDeepStrictEqual(selected.plan?.baseRevision, before.revision)) fail("selected preview is stale or incomplete");
  const operations = selected.plan?.operations;
  const provenance = selected.plan?.details?.candidateProvenance;
  if (!Array.isArray(operations) || operations.length !== approval.cuts.length || !Array.isArray(provenance)
    || provenance.length !== operations.length) fail("selected operation set differs");
  const same = (range, start, end) => range && Number.isFinite(range.start) && Number.isFinite(range.end)
    && Math.abs(range.start - start) <= 1e-9 && Math.abs(range.end - end) <= 1e-9;
  for (const cut of approval.cuts) {
    const matches = operations.map((operation, index) => ({ operation, index })).filter(item => item.operation.candidateId === cut.candidateId);
    if (matches.length !== 1) fail("approved operation is missing or duplicated");
    const { operation, index } = matches[0];
    const start = cut.startFrame * frameSeconds; const end = cut.endFrame * frameSeconds;
    const mapping = provenance.filter(item => item.candidateId === cut.candidateId && item.operationIndex === index);
    if (![start, end, clipStart, sourceStart, clipDuration].every(Number.isFinite) || start < approval.range.start || end > approval.range.end
      || start < clipStart || end > clipStart + clipDuration || operation.type !== "ripple-delete" || operation.timelineId !== before.timeline.id
      || !same(operation.range, start, end) || mapping.length !== 1 || mapping[0].occurrenceId !== clip.id
      || !same(mapping[0].operationRange, start, end) || !same(mapping[0].sourceDeleteRange, sourceStart + start - clipStart, sourceStart + end - clipStart)) fail("approved frame/source range or occurrence differs");
  }
  return selected;
}
