import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const outcomes = {
  quiet: "verified", loud: "verified", "nonzero-gain": "verified", "repeated-source": "verified",
  "already-normalized": "no-op", silent: "skip", "no-dialogue": "skip", "too-short": "skip", "gain-limits": "skip", "peak-risk": "skip",
  "malformed-measurement": "rejected", "stale-preview": "rejected", "provider-mismatch": "rejected", "range-mismatch": "rejected",
  "revision-mismatch": "rejected", "source-cache": "rejected", "failed-measurement": "rejected",
  "post-write-measurement-failure": "recovered", "unexpected-diff": "recovered", "recovery-failure": "recovery-required",
};
const reasons = { silent: ["SILENCE"], "no-dialogue": ["NO_DIALOGUE"], "too-short": ["DIALOGUE_TOO_SHORT", "INSUFFICIENT_DURATION"],
  "gain-limits": ["GAIN_OUT_OF_BOUNDS"], "peak-risk": ["PEAK_RISK"], "malformed-measurement": ["ANALYSIS_INVALID", "MEASUREMENT_INVALID"],
  "stale-preview": ["STALE_CONTEXT"], "provider-mismatch": ["ANALYSIS_INVALID", "MEASUREMENT_EVIDENCE_CHANGED"],
  "range-mismatch": ["ANALYSIS_INVALID", "MEASUREMENT_TARGET_MISMATCH"], "revision-mismatch": ["ANALYSIS_STALE", "MEASUREMENT_TARGET_MISMATCH"],
  "source-cache": ["OCCURRENCE_SIGNAL_UNAVAILABLE", "MEASUREMENT_EVIDENCE_CHANGED"], "failed-measurement": ["OCCURRENCE_SIGNAL_UNAVAILABLE", "OCCURRENCE_SIGNAL_TIMEOUT"],
  "post-write-measurement-failure": ["POST_WRITE_MEASUREMENT_FAILED"], "unexpected-diff": ["UNEXPECTED_DIFF"], "recovery-failure": ["RECOVERY_REQUIRED"] };
const check = (condition, message) => assert.ok(condition, `dialogue acceptance: ${message}`);
const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const hash = value => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const id = value => typeof value === "string" && /^[\w.:+-]{1,200}$/.test(value);
const equal = isDeepStrictEqual;
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value?.[key]]));
const targetKeys = ["projectId", "sequenceId", "occurrenceId", "mediaId"];
const policyKeys = ["targetLufs", "toleranceDb", "maxTruePeakDb", "minGainDb", "maxGainDb", "minDialogueDurationSeconds"];
const referenceKeys = ["sourceDigest", "sourceRange", "sequenceRange", "baselineDigest", "expectedAfterDigest", "expectedGainDb", "untouchedDigest", "unrelatedDigest", "beforeLufs", "afterLufs", "beforeTruePeakDb", "afterTruePeakDb", "toleranceDb", "reusedOccurrenceId", "dialoguePresent"];
export const dialogueNativeScenarioIds = Object.freeze(Object.keys(outcomes));

/** Validates recorded observations; it cannot authenticate how native observations were acquired. */
export function validateDialogueNativeAcceptance(run) {
  const a = run?.acceptance; const commit = run?.environment?.gitCommit;
  check(run?.passed === true && run?.schemaVersion === 2 && /^[a-f0-9]{40}$/.test(commit ?? "") && a?.candidateCommit === commit, "candidate-bound schema v2 is required");
  check(run.editor?.backend === "final-cut-live", "production editor identity is missing");
  const e = run.capabilities?.editor;
  check(e?.canonicalTimelineMode === "canonical-write" && ["timelineSnapshotRead", "timelineWrite", "readAfterWrite", "rollback"].every(key => e[key] === true)
    && (e.singleOperationTransactions === true || e.compositeTransactions === true) && e.semanticOperations?.["set-gain"] === true
    && run.capabilities?.analyzers?.audioLoudness === true, "required native capabilities are missing");
  const names = ["package", "plugin", "workflow-extension", "audio-exporter", "audio-meter"];
  check(Array.isArray(a.components) && a.components.length === names.length && names.every(name => a.components.filter(c => c.name === name).length === 1), "loaded component identities are missing");
  const components = a.components.map(c => {
    check(id(c.version) && /^[a-f0-9]{40}$/.test(c.expectedCommit ?? "") && c.observedCommit === c.expectedCommit && hex(c.artifactDigest)
      && (!names.slice(0, 3).includes(c.name) || c.expectedCommit === commit), "loaded component differs from candidate");
    return { ...pick(c, ["name", "version", "expectedCommit", "observedCommit", "artifactDigest"]),
      ...(c.name.startsWith("audio-") ? { descriptor: descriptor(c.descriptor) } : {}),
      ...(c.name === "audio-meter" ? { meterVersion: c.meterVersion } : {}) };
  });
  check(Array.isArray(a.scenarios) && a.scenarios.length === dialogueNativeScenarioIds.length
    && dialogueNativeScenarioIds.every(name => a.scenarios.filter(s => s.id === name).length === 1), "required native scenarios are missing or duplicated");
  const scenarios = a.scenarios.map(s => scenario(s, commit));
  const primary = scenarios.find(s => s.id === "quiet");
  const exporter = components.find(c => c.name === "audio-exporter");
  const meter = components.find(c => c.name === "audio-meter");
  check(typeof meter.meterVersion === "string" && meter.meterVersion.trim(), "loaded meter build is missing");
  for (const s of scenarios.filter(item => item.input)) check(equal(s.input.provider, meter.descriptor)
    && equal(s.input.signal.exporter, exporter.descriptor) && s.input.signal.meterVersion === meter.meterVersion, "measurement provider differs from loaded components");
  if (run.project) check(run.project.id === primary.target.projectId && run.project.sequenceId === primary.target.sequenceId
    && run.project.occurrenceId === primary.target.occurrenceId, "summary project differs");
  if (run.target) check(targetKeys.every(key => run.target[key] === primary.target[key]), "summary target differs");
  if (run.revisions) check(["before", "after", "restored"].every(phase => run.revisions[phase] === primary[phase].revision.id), "summary revisions differ");
  return { candidateCommit: commit, components, scenarios };
}

function scenario(s, commit) {
  const label = detail => `${s.id}: ${detail}`;
  const target = pick(s.target, targetKeys);
  check(targetKeys.every(key => id(target[key])) && s.outcome === outcomes[s.id], label("target or outcome differs"));
  const policy = pick(s.policy, policyKeys);
  check(Object.values(policy).every(Number.isFinite) && policy.toleranceDb > 0 && policy.minDialogueDurationSeconds > 0
    && policy.minGainDb <= 0 && policy.maxGainDb >= 0 && policy.maxTruePeakDb <= 0, label("invalid policy"));
  const reference = pick(s.reference, referenceKeys);
  check(hash(reference.sourceDigest) && [reference.baselineDigest, reference.expectedAfterDigest, reference.untouchedDigest, reference.unrelatedDigest].every(hex)
    && Number.isFinite(reference.expectedGainDb) && range(reference.sourceRange) && range(reference.sequenceRange)
    && Math.abs((reference.sourceRange.end - reference.sourceRange.start) - (reference.sequenceRange.end - reference.sequenceRange.start)) < 1e-6
    && Number.isFinite(reference.toleranceDb) && reference.toleranceDb > 0 && reference.toleranceDb <= policy.toleranceDb, label("independent reference is incomplete"));
  const phases = Object.fromEntries(["before", "after", "restored"].map(phase => {
    const state = s[phase];
    check(hex(state?.digest) && Number.isFinite(state.gainDb) && id(state.revision?.id) && Number.isSafeInteger(state.revision.sequence)
      && Number.isFinite(Date.parse(state.revision.timestamp)) && state.sourceDigest === reference.sourceDigest
      && state.untouchedDigest === reference.untouchedDigest && state.unrelatedDigest === reference.unrelatedDigest, label(`${phase} integrity observation is incomplete`));
    return [phase, { ...pick(state, ["digest", "gainDb", "sourceDigest", "untouchedDigest", "unrelatedDigest"]), revision: pick(state.revision, ["id", "sequence", "timestamp"]) }];
  }));
  const { before, after, restored } = phases;
  const changed = ["verified", "recovered", "recovery-required"].includes(s.outcome);
  check(before.digest === reference.baselineDigest && after.digest === reference.expectedAfterDigest
    && restored.digest === before.digest && restored.gainDb === before.gainDb, label("baseline or full restoration differs"));
  check(changed ? before.digest !== after.digest && after.revision.sequence > before.revision.sequence && restored.revision.sequence > after.revision.sequence
    && new Set([before.revision.id, after.revision.id, restored.revision.id]).size === 3 && s.writeCount === 1
    : equal(before, after) && equal(before, restored) && s.writeCount === 0, label("write count, revisions or non-mutation differs"));
  check(s.previewDigest === before.digest, label("preview changed the baseline"));
  const approval = s.approval;
  const referenceDigest = createHash("sha256").update(JSON.stringify(reference)).digest("hex");
  check(approval?.candidateCommit === commit && targetKeys.every(key => approval[key] === target[key])
    && approval.baselineDigest === before.digest && approval.revisionId === before.revision.id && approval.referenceDigest === referenceDigest
    && approval.gainDb === reference.expectedGainDb && equal(approval.policy, policy)
    && approval.requestDigest === createHash("sha256").update(JSON.stringify({ target, policy, referenceDigest, revision: before.revision })).digest("hex"), label("approval/request differs from reference"));
  const hasToken = s.outcome !== "rejected" || s.id === "stale-preview";
  check(hasToken ? hex(approval.previewTokenDigest) && approval.previewTokenDigest === s.executedTokenDigest
    : approval.previewTokenDigest === undefined && s.executedTokenDigest === undefined, label("preview-token evidence differs from execution phase"));
  if (reasons[s.id]) check(reasons[s.id].includes(s.reason), label("required rejection/recovery reason is missing"));
  if (s.outcome === "recovery-required") check(s.recovery?.writesBlocked === true && s.recovery?.status === "RECOVERY_REQUIRED"
    && id(s.recovery?.restorationOperationId), label("bounded recovery failure and subsequent restoration are missing"));
  if (s.outcome === "recovered") check(s.recovery?.status === "RESTORED" && id(s.recovery?.restorationOperationId), label("rollback observation is missing"));
  if (s.id === "silent") check(reference.beforeLufs === null && reference.beforeTruePeakDb === null, "silent reference must not invent finite levels");
  if (s.id === "no-dialogue") check(reference.dialoguePresent === false, "no-dialogue reference contains dialogue");
  if (s.id === "too-short") check(reference.sourceRange.end - reference.sourceRange.start < policy.minDialogueDurationSeconds, "short reference is not short");
  const desired = policy.targetLufs - reference.beforeLufs;
  if (s.id === "gain-limits") check(Number.isFinite(reference.beforeLufs) && (desired < policy.minGainDb || desired > policy.maxGainDb), "gain-limit reference is within bounds");
  if (s.id === "peak-risk") check(Number.isFinite(reference.beforeTruePeakDb)
    && reference.beforeTruePeakDb + Math.min(policy.maxGainDb, Math.max(policy.minGainDb, desired)) > policy.maxTruePeakDb, "peak-risk reference is safe");
  let input; let output;
  if (["verified", "no-op"].includes(s.outcome)) {
    input = signal(s.input, before, target, reference, policy);
    output = signal(s.output, after, target, reference, policy);
    check(input.signal.requestId !== output.signal.requestId && equal(input.provider, output.provider)
      && equal(input.signal.exporter, output.signal.exporter) && input.signal.meterVersion === output.signal.meterVersion, label("measurement was reused or provider changed"));
    check(!changed || input.signal.outputDigest !== output.signal.outputDigest, label("post-gain output is unchanged"));
    check(after.gainDb === reference.expectedGainDb && Math.abs(output.integratedLufs - policy.targetLufs) <= policy.toleranceDb
      && output.truePeakDb <= policy.maxTruePeakDb, label("actual output violates policy"));
    check([[input.integratedLufs, reference.beforeLufs], [output.integratedLufs, reference.afterLufs],
      [input.truePeakDb, reference.beforeTruePeakDb], [output.truePeakDb, reference.afterTruePeakDb]].every(([observed, expected]) => Number.isFinite(expected)
        && Math.abs(observed - expected) <= reference.toleranceDb), label("independent measured reference differs"));
    const gainDelta = after.gainDb - before.gainDb;
    check(gainDelta >= policy.minGainDb && gainDelta <= policy.maxGainDb, label("executed gain exceeds bounds"));
    if (s.outcome === "no-op") check(Math.abs(input.integratedLufs - policy.targetLufs) <= policy.toleranceDb && input.truePeakDb <= policy.maxTruePeakDb
      && Math.abs(input.integratedLufs - output.integratedLufs) <= reference.toleranceDb && Math.abs(input.truePeakDb - output.truePeakDb) <= reference.toleranceDb, "NO_OP signal is outside policy or changed");
    if (s.id === "quiet") check(input.integratedLufs < policy.targetLufs - policy.toleranceDb && after.gainDb > before.gainDb, "quiet scenario did not increase gain");
    if (s.id === "loud") check(input.integratedLufs > policy.targetLufs + policy.toleranceDb && after.gainDb < before.gainDb, "loud scenario did not reduce gain");
    if (s.id === "nonzero-gain") check(before.gainDb !== 0 && Math.abs((after.gainDb - before.gainDb) - (policy.targetLufs - input.integratedLufs)) <= policy.toleranceDb, "nonzero starting gain was not tested");
    if (s.id === "repeated-source") check(id(reference.reusedOccurrenceId) && reference.reusedOccurrenceId !== target.occurrenceId, "repeated source identity is missing");
  }
  return { id: s.id, outcome: s.outcome, target, policy, reference, ...phases, writeCount: s.writeCount,
    previewDigest: s.previewDigest, executedTokenDigest: s.executedTokenDigest,
    approval: { ...pick(approval, ["candidateCommit", ...targetKeys, "baselineDigest", "revisionId", "referenceDigest", "gainDb", "previewTokenDigest", "requestDigest"]), policy },
    ...(s.reason ? { reason: s.reason } : {}), ...(input ? { input, output } : {}),
    ...(s.recovery ? { recovery: pick(s.recovery, ["status", "writesBlocked", "restorationOperationId"]) } : {}) };
}
function range(r) { return r && Number.isFinite(r.start) && Number.isFinite(r.end) && r.start >= 0 && r.end > r.start; }
function descriptor(d) {
  check([d?.id, d?.provider, d?.version].every(id), "measurement provider identity/version is missing");
  return pick(d, ["id", "provider", "version"]);
}
function signal(m, state, target, reference, policy) {
  const p = m?.signal; const duration = reference.sourceRange.end - reference.sourceRange.start;
  check(m && [m.integratedLufs, m.truePeakDb, m.silenceMs, m.durationSeconds].every(Number.isFinite)
    && m.silenceMs >= 0 && m.silenceMs < duration * 1000 && Math.abs(m.durationSeconds - duration) < 1e-6
    && duration >= policy.minDialogueDurationSeconds && m.mediaId === target.mediaId && m.occurrenceId === target.occurrenceId
    && equal(m.revision, state.revision) && equal(m.sourceRange, reference.sourceRange) && m.sourceDigest === reference.sourceDigest, "signal measurement target/range/revision differs");
  check(p?.scope === "isolated-occurrence" && p.origin === "editor-export" && p.effectScope === "gain-only" && id(p.requestId)
    && p.projectId === target.projectId && p.sequenceId === target.sequenceId && p.canonicalDigest === state.digest
    && equal(p.sequenceRange, reference.sequenceRange) && p.gainDb === state.gainDb && hash(p.outputDigest)
    && Number.isSafeInteger(p.sampleRate) && p.sampleRate > 0 && Number.isSafeInteger(p.sampleCount) && p.sampleCount > 0
    && Math.abs(p.sampleCount / p.sampleRate - duration) <= 1 / p.sampleRate + 1e-9 && typeof p.meterVersion === "string" && p.meterVersion.trim(), "actual exported signal provenance is incomplete");
  return { ...pick(m, ["integratedLufs", "truePeakDb", "silenceMs", "durationSeconds", "mediaId", "occurrenceId", "sourceDigest"]),
    revision: state.revision, sourceRange: reference.sourceRange, provider: descriptor(m.provider),
    signal: { ...pick(p, ["scope", "origin", "effectScope", "requestId", "projectId", "sequenceId", "canonicalDigest", "gainDb", "outputDigest", "sampleRate", "sampleCount", "meterVersion"]),
      sequenceRange: reference.sequenceRange, exporter: descriptor(p.exporter) } };
}

export { signal as validateDialogueSignalObservation };
