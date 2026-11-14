import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { validateFillerNativeAcceptance } from "./final-cut-filler-acceptance.mjs";
import { validateDialogueNativeAcceptance, validateDialogueSignalObservation } from "./final-cut-dialogue-acceptance.mjs";

const check = (condition, detail) => assert.ok(condition, `speech cleanup: ${detail}`);
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === "string" && /^[\w.:+-]{1,200}$/.test(value);
const equal = isDeepStrictEqual;
const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-6;
const range = (a, b) => a && b && near(a.start, b.start) && near(a.end, b.end);

/** Compare separately validated suites with the actual combined-run observations.
 * This checks consistency of receipts, not their authenticity or native acquisition.
 */
export function assessSpeechCleanup(input) {
  try {
    const commit = input?.candidateCommit;
    check(/^[a-f0-9]{40}$/.test(commit ?? ""), "pin a full candidate commit");
    check(input.filler?.passed === true && input.dialogue?.passed === true, "both native suites must pass; diagnostics are insufficient");
    check(input.filler.environment?.gitCommit === commit && input.dialogue.environment?.gitCommit === commit, "suite candidate differs");
    check(equal(input.filler.editor, input.dialogue.editor), "loaded editor identity differs");
    const filler = validateFillerNativeAcceptance(input.filler);
    const dialogue = validateDialogueNativeAcceptance(input.dialogue);
    for (const name of ["package", "plugin", "workflow-extension"]) check(equal(filler.components.find(c => c.name === name), dialogue.components.find(c => c.name === name)), "loaded production components differ");
    for (const key of ["framekitVersion", "finalCutVersion", "platform", "architecture", "osVersion"]) {
      check(input.filler.environment[key] === input.dialogue.environment[key], `suite environment differs: ${key}`);
    }
    const combined = input.combined;
    check(combined?.schemaVersion === 1 && combined.evidenceType === "headed-native-speech-cleanup" && combined.candidateCommit === commit, "combined receipt schema/candidate differs");
    check(Array.isArray(combined.cases) && combined.cases.length === 2
      && ["success", "normalization-failure"].every(name => combined.cases.filter(c => c.id === name).length === 1), "success and second-stage failure cases are required");
    check(new Set(combined.cases.map(c => c.fillerScenarioId)).size === 2 && new Set(combined.cases.map(c => c.dialogueScenarioId)).size === 2, "cases must have distinct observed stage executions");
    const cases = combined.cases.map(c => validateCase(c, filler, dialogue));
    return { schemaVersion: 1, evidenceType: "speech-cleanup-gate", candidateCommit: commit, passed: true, outcome: "PASS", cases,
      evidenceTier: "headed-native", acquisitionAuthenticated: false, blockers: [] };
  } catch (error) {
    return { schemaVersion: 1, evidenceType: "speech-cleanup-gate", passed: false, outcome: "NO_GO", cases: [],
      evidenceTier: "headed-native", acquisitionAuthenticated: false, blockers: [error instanceof Error ? error.message : "incomplete evidence"] };
  }
}

function validateCase(c, filler, dialogue) {
  const f = filler.scenarios.find(s => s.id === c.fillerScenarioId);
  const n = dialogue.scenarios.find(s => s.id === c.dialogueScenarioId);
  check(f?.outcome === "verified" && n?.outcome === (c.id === "success" ? "verified" : "recovered"), "stage outcome does not match the combined case");
  check(f.target.projectId === n.target.projectId && f.target.sequenceId === n.target.sequenceId, "stages belong to different projects/sequences");
  check(f.after.digest === n.before.digest && equal(f.after.revision, n.before.revision), "normalization did not start at the observed post-filler state");
  check(n.restored.digest === f.after.digest && f.restored.digest === f.before.digest, "stage restoration did not preserve the correct baseline");
  const revisions = [f.before.revision, f.after.revision, n.after.revision, n.restored.revision, f.restored.revision];
  check(new Set(revisions.map(r => r.id)).size === 5 && revisions.every((r, i) => i === 0 || r.sequence > revisions[i - 1].sequence), "execution and two-stage restoration order differs");
  const old = c.preCutPreview;
  check(hash(old?.tokenDigest) && id(old.requestId) && old.canonicalDigest === f.before.digest && equal(old.revision, f.before.revision)
    && old.occurrenceId === f.target.occurrenceId && old.mediaId === n.target.mediaId
    && old.sourceDigest === n.reference.sourceDigest
    && f.sourceIntegrity.before.some(source => source.mediaId === old.mediaId && `sha256:${source.digest}` === old.sourceDigest), "pre-cut preview is not bound to the original source/target");
  rejectWithoutWrite(c.oldTokenRejection, ["STALE_CONTEXT"], f.after);
  rejectWithoutWrite(c.oldMappingRejection, ["OCCURRENCE_NOT_FOUND", "STALE_CONTEXT", "TARGET_MISMATCH", "ANALYSIS_INVALID"], f.after);
  rejectWithoutWrite(c.oldMeasurementRejection, ["ANALYSIS_INVALID", "ANALYSIS_STALE", "TARGET_MISMATCH", "OCCURRENCE_SIGNAL_UNAVAILABLE"], f.after);
  check(c.oldTokenRejection.tokenDigest === old.tokenDigest && c.oldMappingRejection.occurrenceId === old.occurrenceId
    && c.oldMeasurementRejection.requestId === old.requestId, "rejection does not identify the rejected token/mapping/measurement");
  check(c.refreshedPreviewTokenDigest === n.approval.previewTokenDigest, "refreshed measurement belongs to a different approved preview");
  check(old.tokenDigest !== n.approval.previewTokenDigest, "normalization reused the pre-cut preview token");
  const expected = retainedMappings(old, f.reference);
  check(Array.isArray(c.mapping) && c.mapping.length === expected.length && new Set(c.mapping.map(m => m.occurrenceId)).size === expected.length
    && c.mapping.every((m, index) => id(m.occurrenceId) && range(m.sourceRange, expected[index].sourceRange) && range(m.sequenceRange, expected[index].sequenceRange)), "refreshed source-preserving mapping differs from approved cuts");
  const selected = c.mapping.filter(m => m.occurrenceId === n.target.occurrenceId);
  check(selected.length === 1 && range(selected[0].sourceRange, n.reference.sourceRange) && range(selected[0].sequenceRange, n.reference.sequenceRange)
    && !range(old.sourceRange, selected[0].sourceRange), "normalization reused the old occurrence range");
  const refreshed = validateDialogueSignalObservation(c.refreshedMeasurement, n.before, n.target, n.reference, n.policy);
  const meter = dialogue.components.find(component => component.name === "audio-meter");
  const exporter = dialogue.components.find(component => component.name === "audio-exporter");
  check(refreshed.signal.requestId !== old.requestId && equal(refreshed.provider, meter.descriptor)
    && equal(refreshed.signal.exporter, exporter.descriptor) && refreshed.signal.meterVersion === meter.meterVersion
    && Math.abs(refreshed.integratedLufs - n.reference.beforeLufs) <= n.reference.toleranceDb
    && Math.abs(refreshed.truePeakDb - n.reference.beforeTruePeakDb) <= n.reference.toleranceDb, "fresh post-cut measurement is missing or differs from reference");
  if (n.input) check(equal(refreshed, n.input), "executed normalization used a different refreshed measurement");
  check(hash(c.unrelatedBeforeDigest) && c.unrelatedBeforeDigest === n.reference.unrelatedDigest
    && c.unrelatedRestoredDigest === c.unrelatedBeforeDigest, "unrelated-project integrity differs");
  return { id: c.id, fillerScenarioId: f.id, dialogueScenarioId: n.id, projectId: n.target.projectId, sequenceId: n.target.sequenceId,
    normalizationOccurrenceId: n.target.occurrenceId, revisions: revisions.map(r => r.id),
    originalDigest: f.before.digest, postFillerDigest: f.after.digest, finalDigest: n.after.digest,
    normalizationRestoredDigest: n.restored.digest, restoredDigest: f.restored.digest, passed: true };
}
function rejectWithoutWrite(rejection, codes, state) {
  check(codes.includes(rejection?.code) && rejection.writes === 0 && rejection.digest === state.digest && equal(rejection.revision, state.revision), "stale token/mapping/measurement rejection changed state or lacks an observed error");
}
function retainedMappings(old, reference) {
  const source = old.sourceRange; const sequence = old.sequenceRange;
  check(source && sequence && [source.start, source.end, sequence.start, sequence.end].every(Number.isFinite)
    && source.start >= 0 && sequence.start >= 0 && source.end > source.start
    && near(source.end - source.start, sequence.end - sequence.start), "original occurrence ranges are invalid");
  const frame = Number(reference.frameDuration.value) / Number(reference.frameDuration.timescale);
  const cuts = reference.expectedCuts.map(cut => ({ ...cut, start: cut.startFrame * frame, end: cut.endFrame * frame })).sort((a, b) => a.start - b.start);
  check(cuts.length > 0 && cuts.every(cut => cut.occurrenceId === old.occurrenceId && cut.start >= sequence.start && cut.end <= sequence.end), "combined target cuts are outside the original occurrence");
  const kept = []; let cursor = sequence.start; let removed = 0;
  const append = end => { if (end > cursor) kept.push({ sourceRange: { start: source.start + cursor - sequence.start, end: source.start + end - sequence.start }, sequenceRange: { start: cursor - removed, end: end - removed } }); };
  for (const cut of cuts) { check(cut.start >= cursor, "approved cuts overlap"); append(cut.start); removed += cut.end - cut.start; cursor = cut.end; }
  append(sequence.end);
  return kept;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const usage = "Usage: node scripts/final-cut-speech-cleanup-gate.mjs --candidate-commit SHA --filler FILE --dialogue FILE --combined FILE";
  if (process.argv.includes("--help")) process.stdout.write(`${usage}\n`);
  else {
    let report;
    try {
      const args = process.argv.slice(2); const options = {};
      check(args.length === 8, usage);
      for (let i = 0; i < args.length; i += 2) {
        check(["--candidate-commit", "--filler", "--dialogue", "--combined"].includes(args[i]) && !options[args[i]], usage);
        options[args[i]] = args[i + 1];
      }
      const read = async flag => { try { return JSON.parse(await readFile(options[flag], "utf8")); } catch { throw new Error(`speech cleanup: unreadable JSON for ${flag}`); } };
      const [filler, dialogue, combined] = await Promise.all([read("--filler"), read("--dialogue"), read("--combined")]);
      report = assessSpeechCleanup({ candidateCommit: options["--candidate-commit"], filler, dialogue, combined });
    } catch (error) { report = { schemaVersion: 1, evidenceType: "speech-cleanup-gate", passed: false, outcome: "NO_GO", cases: [], blockers: [error.message] }; }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.passed) process.exitCode = 1;
  }
}
