import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { fillerNativeEvidence } from "./filler-native-fixture.js";
import { dialogueNativeFixture } from "./dialogue-native-fixture.js";
import { assessSpeechCleanup } from "../../scripts/final-cut-speech-cleanup-gate.mjs";

const hash = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
// Contract fixtures only; these are never native execution receipts.
function fixture(): any {
  const filler: any = fillerNativeEvidence(); const candidate = filler.environment.gitCommit;
  const dialogue: any = dialogueNativeFixture(candidate);
  const target = dialogue.acceptance.scenarios[0].target;
  const sourceDigest = dialogue.acceptance.scenarios[0].reference.sourceDigest;
  for (const s of filler.acceptance.scenarios) {
    for (const value of [s.target, s.approval, s.editedSpeech].filter(Boolean)) { value.projectId = target.projectId; value.sequenceId = target.sequenceId; }
    for (const sources of Object.values(s.sourceIntegrity) as any[]) for (const source of sources) { source.mediaId = target.mediaId; source.digest = sourceDigest.slice(7); }
    if (s.reference.reusedSource) {
      s.reference.reusedSource.mediaId = target.mediaId; s.reference.reusedSource.sourceDigest = sourceDigest.slice(7);
      s.reusedSourceReadback.mediaId = target.mediaId; s.reusedSourceReadback.sourceDigest = sourceDigest.slice(7);
      s.approval.referenceDigest = hash(s.reference);
    }
  }
  Object.assign(filler.project, { id: target.projectId, sequenceId: target.sequenceId });
  Object.assign(filler.target, { projectId: target.projectId, sequenceId: target.sequenceId });
  const cases = [["success", "reviewed-removal", "quiet"], ["normalization-failure", "repeated-source", "post-write-measurement-failure"]].map(([id, fillerId, dialogueId]) => {
    const f = filler.acceptance.scenarios.find((s: any) => s.id === fillerId);
    const n = dialogue.acceptance.scenarios.find((s: any) => s.id === dialogueId);
    const revision = (phase: string, sequence: number) => ({ id: `${id}:${phase}`, sequence, timestamp: `2026-11-15T00:00:0${sequence}.000Z` });
    f.before.revision = revision("before", 1); f.after.revision = revision("cut", 2); f.restored.revision = revision("restored", 5);
    f.approval.beforeRevisionId = f.before.revision.id;
    f.editedSpeech.revisionId = f.after.revision.id;
    const start = 24 * 1001 / 24000; const end = 36 * 1001 / 24000;
    n.before.digest = f.after.digest; n.before.revision = f.after.revision;
    n.after.revision = revision("normalized", 3); n.restored.digest = f.after.digest; n.restored.revision = revision("normalization-restored", 4);
    n.reference.baselineDigest = f.after.digest; n.reference.sourceRange = { start: end, end: 4 };
    n.reference.sequenceRange = { start, end: 4 - (end - start) };
    n.previewDigest = f.after.digest;
    n.approval.baselineDigest = f.after.digest; n.approval.revisionId = f.after.revision.id;
    n.approval.referenceDigest = hash(n.reference);
    n.approval.requestDigest = hash({ target: n.target, policy: n.policy, referenceDigest: n.approval.referenceDigest, revision: n.before.revision });
    const makeMeasurement = (base: any, state: any, requestId: string) => ({ ...structuredClone(base), revision: state.revision,
      durationSeconds: 4 - end, sourceRange: n.reference.sourceRange, signal: { ...structuredClone(base.signal), requestId,
        canonicalDigest: state.digest, sequenceRange: n.reference.sequenceRange, sampleCount: Math.round((4 - end) * 48000), gainDb: state.gainDb } });
    const referenceInput = dialogue.acceptance.scenarios.find((s: any) => s.id === "loud").input;
    const refresh = makeMeasurement(n.input ?? { ...referenceInput, integratedLufs: -20, truePeakDb: -10 }, n.before, `${id}:refresh`);
    if (n.input) { n.input = refresh; n.output = makeMeasurement(n.output, n.after, `${id}:output`); }
    return { id, fillerScenarioId: fillerId, dialogueScenarioId: dialogueId,
      preCutPreview: { tokenDigest: hash(`${id}:old-token`), revision: f.before.revision, canonicalDigest: f.before.digest,
        requestId: `${id}:old-audio`, sourceDigest, mediaId: target.mediaId, occurrenceId: f.target.occurrenceId,
        sourceRange: { start: 0, end: 4 }, sequenceRange: { start: 0, end: 4 } },
      oldTokenRejection: { code: "STALE_CONTEXT", revision: f.after.revision, digest: f.after.digest, writes: 0 },
      oldMappingRejection: { code: "OCCURRENCE_NOT_FOUND", revision: f.after.revision, digest: f.after.digest, writes: 0 },
      oldMeasurementRejection: { code: "ANALYSIS_INVALID", revision: f.after.revision, digest: f.after.digest, writes: 0 },
      mapping: [ { occurrenceId: "remapped-left", sourceRange: { start: 0, end: start }, sequenceRange: { start: 0, end: start } },
        { occurrenceId: target.occurrenceId, sourceRange: n.reference.sourceRange, sequenceRange: n.reference.sequenceRange } ],
      refreshedMeasurement: refresh, unrelatedBeforeDigest: n.reference.unrelatedDigest, unrelatedRestoredDigest: n.reference.unrelatedDigest };
  });
  const reviewed = filler.acceptance.scenarios[0];
  filler.removal.beforeRevision = reviewed.before.revision; filler.removal.afterRevision = reviewed.after.revision;
  filler.restoration.restoredRevision = reviewed.restored.revision;
  filler.revisions = { before: reviewed.before.revision.id, after: reviewed.after.revision.id, restored: reviewed.restored.revision.id };
  const quiet = dialogue.acceptance.scenarios[0];
  dialogue.revisions = { before: quiet.before.revision.id, after: quiet.after.revision.id, restored: quiet.restored.revision.id };
  return { candidateCommit: candidate, filler, dialogue, combined: { schemaVersion: 1, evidenceType: "headed-native-speech-cleanup", candidateCommit: candidate, cases } };
}

test("combined native gate requires both complete suites and their chronological binding", () => {
  const input = fixture(); const result = assessSpeechCleanup(input);
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.outcome, "PASS"); assert.equal(result.cases.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /sourceRange|tokenDigest/);
});

test("combined gate returns NO_GO for missing, diagnostic, stale or disconnected evidence", () => {
  const changes: Array<(input: any) => void> = [
    i => { delete i.filler; }, i => { i.dialogue.passed = false; }, i => { i.combined.cases.pop(); },
    i => { i.dialogue.environment.gitCommit = "a".repeat(40); },
    i => { i.combined.cases[0].oldTokenRejection.writes = 1; },
    i => { i.combined.cases[0].oldTokenRejection.digest = hash("changed"); },
    i => { i.combined.cases[0].oldMappingRejection.code = "NO_ERROR"; },
    i => { i.combined.cases[0].oldMeasurementRejection.code = "NO_ERROR"; },
    i => { i.combined.cases[0].refreshedMeasurement.signal.requestId = i.combined.cases[0].preCutPreview.requestId; },
    i => { i.combined.cases[0].mapping[1].sourceRange.start = 0; },
    i => { i.combined.cases[0].unrelatedRestoredDigest = hash("changed"); },
    i => { i.filler.acceptance.scenarios[0].restored.revision.sequence = 3; },
    i => { i.combined.cases[1].dialogueScenarioId = "quiet"; },
    i => { i.dialogue.acceptance.components[0].artifactDigest = hash("different package"); },
  ];
  for (const change of changes) { const input = fixture(); change(input); const result = assessSpeechCleanup(input); assert.equal(result.passed, false); assert.equal(result.outcome, "NO_GO"); assert.ok(result.blockers.length); }
});
