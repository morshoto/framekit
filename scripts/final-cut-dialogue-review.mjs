import { isDeepStrictEqual } from "node:util";
import { canonicalEvidenceDigest } from "./final-cut-evidence.mjs";

const defaults = { targetLufs: -16, toleranceDb: 0.5, maxTruePeakDb: -1, minGainDb: -6, maxGainDb: 6, minDialogueDurationSeconds: 1 };
const policyEnv = { targetLufs: "TARGET_LUFS", toleranceDb: "TOLERANCE_DB", maxTruePeakDb: "MAX_TRUE_PEAK_DB", minGainDb: "MIN_GAIN_DB", maxGainDb: "MAX_GAIN_DB", minDialogueDurationSeconds: "MIN_DURATION_SECONDS" };
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const digest = value => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const identity = value => typeof value === "string" && value.trim().length > 0;
const reject = detail => { throw new Error(`DIALOGUE_REVIEW_REJECTED: ${detail}`); };
const check = (condition, detail) => { if (!condition) reject(detail); };
const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-6;
const sameRange = (a, b) => a && b && near(a.start, b.start) && near(a.end, b.end);
const seconds = (time, fallback) => time ? Number(time.value) / Number(time.timescale) : fallback;

export function parseDialogueApproval(env) {
  const get = key => env[`FRAMEKIT_FINAL_CUT_E2E_${key}`];
  const invalid = () => new Error("DIALOGUE_APPROVAL_REQUIRED: supply mutation consent, candidate, baseline, exact target, source digest and approved absolute gain");
  const required = ["PROJECT", "PROJECT_ID", "SEQUENCE_ID", "REVISION_ID", "OCCURRENCE", "APPROVED_GAIN_DB"];
  if (get("ALLOW_MUTATION") !== "1" || !/^[a-f0-9]{40}$/.test(get("CANDIDATE_COMMIT") ?? "")
    || required.some(key => !identity(get(key))) || !sha(get("BASELINE_DIGEST")) || !digest(get("SOURCE_DIGEST"))) throw invalid();
  const gainDb = Number(get("APPROVED_GAIN_DB"));
  const policy = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => {
    const value = env[`FRAMEKIT_DIALOGUE_${policyEnv[key]}`];
    if (value !== undefined && !identity(value)) throw invalid();
    return [key, value === undefined ? fallback : Number(value)];
  }));
  if (!Number.isFinite(gainDb) || !Object.values(policy).every(Number.isFinite) || policy.toleranceDb <= 0
    || policy.minDialogueDurationSeconds <= 0 || policy.minGainDb > 0 || policy.maxGainDb < 0
    || policy.minGainDb > policy.maxGainDb || policy.maxTruePeakDb > 0) throw invalid();
  return { projectName: get("PROJECT"), projectId: get("PROJECT_ID"), sequenceId: get("SEQUENCE_ID"), revisionId: get("REVISION_ID"),
    occurrenceId: get("OCCURRENCE"), candidateCommit: get("CANDIDATE_COMMIT"), baselineDigest: get("BASELINE_DIGEST"), sourceDigest: get("SOURCE_DIGEST"), gainDb, policy };
}

export function requireDialogueCapabilities(editor) {
  const e = editor.capabilities?.editor;
  if (e?.canonicalTimelineMode !== "canonical-write" || !["timelineSnapshotRead", "timelineWrite", "readAfterWrite", "rollback"].every(key => e[key] === true)
    || (e.compositeTransactions !== true && e.singleOperationTransactions !== true)
    || e.semanticOperations?.["set-gain"] !== true || editor.capabilities?.analyzers?.audioLoudness !== true) {
    throw new Error("CAPABILITY_UNAVAILABLE: canonical gain, single-operation transactions, readback, rollback and audio measurement are required");
  }
}

function target(snapshot, approval) {
  check(snapshot?.projectId === approval.projectId && snapshot.projectName === approval.projectName && snapshot.timeline?.id === approval.sequenceId, "approved target differs");
  const clips = snapshot.timeline.clips.filter(clip => clip.id === approval.occurrenceId);
  check(clips.length === 1, "occurrence is missing or ambiguous");
  const clip = clips[0];
  const media = snapshot.media.filter(item => item.mediaId === clip.mediaId);
  check(media.length === 1 && media[0].sourceDigest === approval.sourceDigest, "source identity differs");
  const sourceStart = seconds(clip.sourceStartTime, clip.sourceStart ?? 0);
  const start = seconds(clip.startTime, clip.start);
  const duration = seconds(clip.durationTime, clip.duration);
  check([sourceStart, start, duration, clip.gainDb ?? 0].every(Number.isFinite) && sourceStart >= 0 && duration > 0, "occurrence range or gain is invalid");
  return { clip, media: media[0], sourceRange: { start: sourceStart, end: sourceStart + duration }, sequenceRange: { start, end: start + duration }, duration };
}

/** Validate and allowlist actual exported-output observations. No gain prediction. */
export function reviewDialogueMeasurement(measurement, snapshot, approval) {
  const t = target(snapshot, approval);
  const signal = measurement?.signalProvenance;
  const provider = descriptor(measurement?.provider);
  const exporter = descriptor(signal?.exporter);
  check(measurement?.signalScope === "occurrence" && measurement.valid === true && measurement.dialoguePresent === true
    && Number.isFinite(measurement.integratedLufs) && Number.isFinite(measurement.truePeakDb)
    && near(measurement.analyzedDurationSeconds, t.duration) && t.duration >= approval.policy.minDialogueDurationSeconds
    && Number.isFinite(measurement.silenceMs) && measurement.silenceMs >= 0 && measurement.silenceMs < t.duration * 1000, "measurement is invalid");
  check(measurement.mediaId === t.clip.mediaId && measurement.occurrenceId === t.clip.id
    && isDeepStrictEqual(measurement.revision, snapshot.revision) && sameRange(measurement.requestedRange, t.sourceRange)
    && sameRange(measurement.measuredRange, t.sourceRange) && measurement.sourceIdentity?.sourceDigest === approval.sourceDigest
    && measurement.sourceIdentity?.mediaId === t.clip.mediaId, "measurement source/range/revision differs");
  check(signal?.scope === "isolated-occurrence" && signal.origin === "editor-export" && signal.effectScope === "gain-only"
    && signal.projectId === snapshot.projectId && signal.sequenceId === snapshot.timeline.id
    && signal.canonicalDigest === canonicalEvidenceDigest(snapshot) && sameRange(signal.sequenceRange, t.sequenceRange)
    && near(signal.gainDb, t.clip.gainDb ?? 0) && identity(signal.requestId) && identity(signal.meterVersion)
    && digest(signal.outputDigest)
    && Number.isSafeInteger(signal.sampleRate) && signal.sampleRate > 0 && Number.isSafeInteger(signal.sampleCount) && signal.sampleCount > 0
    && Math.abs(signal.sampleCount / signal.sampleRate - t.duration) <= 1 / signal.sampleRate + 1e-9, "exported signal is missing or mismatched");
  return { integratedLufs: measurement.integratedLufs, truePeakDb: measurement.truePeakDb,
    silenceMs: measurement.silenceMs, durationSeconds: t.duration, mediaId: t.clip.mediaId, occurrenceId: t.clip.id,
    revision: structuredClone(snapshot.revision), sourceDigest: approval.sourceDigest, sourceRange: t.sourceRange,
    provider, signal: { scope: signal.scope, origin: signal.origin, effectScope: signal.effectScope, requestId: signal.requestId,
      projectId: signal.projectId, sequenceId: signal.sequenceId, canonicalDigest: signal.canonicalDigest,
      sequenceRange: t.sequenceRange, gainDb: signal.gainDb, outputDigest: signal.outputDigest,
      sampleRate: signal.sampleRate, sampleCount: signal.sampleCount, exporter, meterVersion: signal.meterVersion } };
}

function descriptor(value) {
  check(value && [value.id, value.provider, value.version].every(identity), "provider identity/version is missing");
  return { id: value.id, provider: value.provider, version: value.version };
}

/** Read/preview only. The caller must check loaded components before execution. */
export async function previewApprovedDialogue(callJson, readProject, before, approval) {
  const t = target(before, approval);
  check(before.revision.id === approval.revisionId && canonicalEvidenceDigest(before) === approval.baselineDigest, "approved baseline differs");
  const args = { mediaId: t.clip.mediaId, occurrenceId: t.clip.id, ...approval.policy };
  const preview = await callJson("skill.preview", { skill: "dialogue-normalization", arguments: { baseRevision: before.revision, ...args } });
  const current = await readProject();
  check(isDeepStrictEqual(current.revision, before.revision) && canonicalEvidenceDigest(current) === approval.baselineDigest, "preview changed the baseline");
  const plan = preview.plan;
  check(identity(preview.previewToken) && Number.isFinite(Date.parse(preview.expiresAt)) && Date.parse(preview.expiresAt) > Date.now()
    && isDeepStrictEqual(plan?.baseRevision, before.revision) && isDeepStrictEqual(plan.normalizedInput, args), "preview token, revision or policy differs");
  check(plan.decision === "APPLY" && plan.operations?.length === 1, "approved gain requires exactly one APPLY operation");
  const op = plan.operations[0];
  check(op.type === "set-gain" && op.clipId === t.clip.id && op.gainDb === approval.gainDb
    && isDeepStrictEqual(op.baseRevision, before.revision) && near(plan.details?.existingGainDb, t.clip.gainDb ?? 0)
    && near(plan.details?.targetGainDb, approval.gainDb) && near(plan.details?.clampedGainDb, approval.gainDb - (t.clip.gainDb ?? 0))
    && plan.details.clampedGainDb >= approval.policy.minGainDb && plan.details.clampedGainDb <= approval.policy.maxGainDb, "approved gain operation differs");
  reviewDialogueMeasurement(plan.details.measurement, before, approval);
  return preview;
}

/** Verify canonical gain isolation, fresh measured signal, and full Undo restoration. */
export function verifyDialogueReadback(before, after, restored, preview, measurement, approval) {
  const input = reviewDialogueMeasurement(preview.plan?.details?.measurement, before, approval);
  const output = reviewDialogueMeasurement(measurement, after, approval);
  const expected = structuredClone(before);
  expected.timeline.clips.find(clip => clip.id === approval.occurrenceId).gainDb = approval.gainDb;
  check(canonicalEvidenceDigest(after) === canonicalEvidenceDigest(expected), "readback changed more than the approved occurrence gain");
  check(output.signal.requestId !== input.signal.requestId && output.signal.outputDigest !== input.signal.outputDigest
    && isDeepStrictEqual(output.provider, input.provider) && isDeepStrictEqual(output.signal.exporter, input.signal.exporter)
    && output.signal.meterVersion === input.signal.meterVersion, "post-gain signal is cached or provider changed");
  check(Math.abs(output.integratedLufs - approval.policy.targetLufs) <= approval.policy.toleranceDb
    && output.truePeakDb <= approval.policy.maxTruePeakDb, "actual output violates loudness or peak policy");
  const revisions = [before.revision, after.revision, restored.revision];
  check(revisions.every(rev => identity(rev?.id) && Number.isSafeInteger(rev.sequence) && identity(rev.timestamp))
    && new Set(revisions.map(rev => rev.id)).size === 3 && before.revision.sequence < after.revision.sequence
    && after.revision.sequence < restored.revision.sequence, "edit/Undo revisions did not advance");
  const beforeDigest = canonicalEvidenceDigest(before); const restoredDigest = canonicalEvidenceDigest(restored);
  check(beforeDigest === approval.baselineDigest && beforeDigest === restoredDigest, "Undo did not restore the full baseline");
  return { input, output, policy: structuredClone(approval.policy), approvedGainDb: approval.gainDb,
    unchangedOccurrenceIds: before.timeline.clips.filter(clip => clip.id !== approval.occurrenceId).map(clip => clip.id),
    restoration: { beforeDigest, restoredDigest, restoredRevision: structuredClone(restored.revision) } };
}
