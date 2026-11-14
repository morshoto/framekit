import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeFillerRemovalEvidence, sanitizeFillerRemovalDiagnostic } from "../../scripts/final-cut-evidence.mjs";
import { fillerNativeEvidence } from "../release-gate/filler-native-fixture.js";
import { loadNativeEditingManifest, summarizeHeadedEvidence } from "../release-gate/native-editing.js";
import { parseFillerApproval, previewApprovedFiller } from "../../scripts/final-cut-filler-review.mjs";
import { fillerTimelineSemanticDigest } from "../../scripts/final-cut-filler-acceptance.mjs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("filler native acceptance preserves reviewed cuts and edited-signal evidence", () => {
  const raw = fillerNativeEvidence();
  const evidence = sanitizeFillerRemovalEvidence(raw, raw.environment);
  assert.equal(evidence.schemaVersion, 2);
  assert.equal(evidence.acceptance.scenarios.length, 12);
  assert.equal(evidence.acceptance.scenarios[0].editedSpeech.scope, "edited-timeline-output");
  const workflow = loadNativeEditingManifest().workflows.find(item => item.id === "filler-removal")!;
  assert.equal(summarizeHeadedEvidence(evidence, workflow).status, "verified");
});

test("filler native gate rejects missing scenarios, source-only continuity and unbound restoration", () => {
  const workflow = loadNativeEditingManifest().workflows.find(item => item.id === "filler-removal")!;
  const mutations: Array<(raw: any) => void> = [
    raw => { delete raw.acceptance; },
    raw => { raw.acceptance.scenarios.pop(); },
    raw => { raw.acceptance.scenarios[0].editedSpeech.scope = "source"; },
    raw => { raw.acceptance.scenarios[0].editedSpeech.revisionId = "old"; },
    raw => { raw.acceptance.scenarios[0].editedSpeech.observedContentDigest = "0".repeat(64); },
    raw => { raw.acceptance.scenarios[0].restored.digest = "0".repeat(64); },
    raw => { raw.acceptance.scenarios[0].review.selectedPreviewDigest = "0".repeat(64); },
    raw => { raw.acceptance.scenarios[0].review.executedPreviewDigest = "0".repeat(64); },
    raw => { raw.acceptance.scenarios[0].review.executedCuts = []; },
    raw => { raw.acceptance.scenarios[0].sourceIntegrity.after = []; },
    raw => { raw.acceptance.components[0].observedCommit = "a".repeat(40); },
    raw => { raw.acceptance.scenarios[0].approval.beforeRevisionId = "wrong"; },
    raw => { raw.acceptance.scenarios[5].after.digest = "0".repeat(64); },
    raw => { raw.acceptance.scenarios[11].failure.restorationVerified = false; },
    raw => { raw.project.occurrenceId = "different"; },
    raw => { raw.restoration.restoredDigest = "0".repeat(64); },
    raw => { raw.removal.removedDurationSeconds = 0.5; },
    raw => { delete raw.acceptance.scenarios[3].reusedSourceReadback; },
    raw => { raw.acceptance.scenarios[3].reusedSourceReadback.afterDigest = "0".repeat(64); },
  ];
  for (const mutate of mutations) {
    const raw = fillerNativeEvidence(); mutate(raw);
    assert.throws(() => sanitizeFillerRemovalEvidence(raw, raw.environment), /filler/i);
    assert.throws(() => summarizeHeadedEvidence(raw, workflow), /filler/i);
  }
});

test("one headed filler diagnostic cannot promote native acceptance", () => {
  const raw = fillerNativeEvidence();
  const diagnostic = sanitizeFillerRemovalDiagnostic(raw, raw.environment);
  assert.equal(diagnostic.passed, false);
  assert.equal(diagnostic.outcome, "NO_GO");
  assert.equal(diagnostic.removal.continuityVerified, false);
  assert.throws(() => summarizeHeadedEvidence(diagnostic, loadNativeEditingManifest().workflows.find(item => item.id === "filler-removal")!), /did not pass/);
});

test("independent filler semantics compare exact source ranges without generated clip IDs", () => {
  const snapshot = { timeline: { frameDuration: { value: "1001", timescale: "24000" }, durationTime: { value: "48048", timescale: "24000" },
    clips: [{ id: "native-assigned", mediaId: "source", track: 0, startTime: { value: "0", timescale: "1" },
      durationTime: { value: "48048", timescale: "24000" }, sourceStartTime: { value: "24024", timescale: "24000" } }] } };
  const expected = fillerTimelineSemanticDigest(snapshot);
  snapshot.timeline.clips[0]!.id = "different-assigned-id";
  snapshot.timeline.clips[0]!.sourceStartTime = { value: "1001", timescale: "1000" };
  assert.equal(fillerTimelineSemanticDigest(snapshot), expected);
  snapshot.timeline.clips[0]!.sourceStartTime = { value: "1002", timescale: "1000" };
  assert.notEqual(fillerTimelineSemanticDigest(snapshot), expected);
});

function reviewFixture() {
  const env = { FRAMEKIT_FINAL_CUT_E2E_ALLOW_MUTATION: "1", FRAMEKIT_FINAL_CUT_E2E_CANDIDATE_COMMIT: "a".repeat(40),
    FRAMEKIT_FINAL_CUT_E2E_PROJECT: "Disposable", FRAMEKIT_FINAL_CUT_E2E_PROJECT_ID: "project", FRAMEKIT_FINAL_CUT_E2E_SEQUENCE_ID: "sequence",
    FRAMEKIT_FINAL_CUT_E2E_REVISION_ID: "before", FRAMEKIT_FINAL_CUT_E2E_OCCURRENCE: "occurrence",
    FRAMEKIT_FINAL_CUT_E2E_RANGE_START: "0", FRAMEKIT_FINAL_CUT_E2E_RANGE_END: "4",
    FRAMEKIT_FINAL_CUT_E2E_APPROVED_CUTS: JSON.stringify([{ candidateId: "candidate", startFrame: 24, endFrame: 36 }]) };
  const before = { projectId: "project", projectName: "Disposable", revision: { id: "before", sequence: 1, timestamp: "2026-11-15T00:00:00.000Z" },
    timeline: { id: "sequence", duration: 4, frameDuration: { value: "1", timescale: "24" },
      clips: [{ id: "occurrence", mediaId: "media", start: 0, duration: 4, sourceStart: 2 }] }, media: [{ mediaId: "media", source: "fixture.wav" }] };
  const preview = { previewToken: "selected-token", expiresAt: "2099-01-01T00:00:00.000Z",
    plan: { baseRevision: before.revision, operations: [{ type: "ripple-delete", timelineId: "sequence", candidateId: "candidate", range: { start: 1, end: 1.5 } }],
      details: { candidates: [{ id: "candidate", occurrenceId: "occurrence", mediaId: "media" }],
        candidateProvenance: [{ candidateId: "candidate", occurrenceId: "occurrence", operationIndex: 0, operationRange: { start: 1, end: 1.5 }, sourceDeleteRange: { start: 3, end: 3.5 } }] } } };
  return { env, before, preview };
}

test("filler runner requires scoped approval and re-previews selected exact cuts", async () => {
  const f = reviewFixture();
  assert.throws(() => parseFillerApproval({ ...f.env, FRAMEKIT_FINAL_CUT_E2E_ALLOW_MUTATION: "0" }), /APPROVAL_REQUIRED/);
  assert.throws(() => parseFillerApproval({ ...f.env, FRAMEKIT_FINAL_CUT_E2E_APPROVED_CUTS: "[]" }), /APPROVAL_REQUIRED/);
  const calls: any[] = [];
  const result = await previewApprovedFiller(async (name: string, args: any) => { calls.push({ name, args }); return structuredClone(f.preview); },
    async () => structuredClone(f.before), f.before, parseFillerApproval(f.env));
  assert.equal(result.previewToken, "selected-token");
  assert.deepEqual(calls.map(call => call.name), ["skill.preview", "skill.preview"]);
  assert.deepEqual(calls[1].args.arguments.selectedCandidateIds, ["candidate"]);
});

test("filler review rejects mutated preview, redirected occurrence or unapproved ranges", async () => {
  for (const mode of ["mutation", "occurrence", "range", "source-range", "expired"]) {
    const f = reviewFixture();
    const preview = structuredClone(f.preview);
    if (mode === "occurrence") preview.plan.details.candidateProvenance[0]!.occurrenceId = "duplicate";
    if (mode === "range") preview.plan.operations[0]!.range.end = 2;
    if (mode === "source-range") preview.plan.details.candidateProvenance[0]!.sourceDeleteRange.start = 0;
    if (mode === "expired") preview.expiresAt = "2000-01-01T00:00:00.000Z";
    await assert.rejects(previewApprovedFiller(async () => preview, async () => {
      const current = structuredClone(f.before);
      if (mode === "mutation") current.timeline.duration = 3;
      return current;
    }, f.before, parseFillerApproval(f.env)), /FILLER_REVIEW/, mode);
  }
});

test("headed filler-removal runner covers live preflight, verification, and rollback", async () => {
  const runner = await readFile(join(repositoryRoot, "scripts/final-cut-filler-removal-headed-e2e.mjs"), "utf8");

  assert.match(runner, /canonical-write/);
  assert.match(runner, /editor\.live\.inspect/);
  assert.match(runner, /skill\.inspect/);
  assert.match(runner, /skill\.preview/);
  assert.match(runner, /skill\.execute/);
  assert.match(runner, /speechVad/);
  assert.match(runner, /ripple-delete/);
  assert.match(runner, /filler-speech-continuity/);
  assert.match(runner, /edit\.undo/);
  assert.match(runner, /schemaVersion:\s*1/);
  assert.match(runner, /evidenceType:\s*"headed-native-filler-removal"/);
});

test("headed Skill runners arm rollback before validating committed results", async () => {
  const fillerRunner = await readFile(join(repositoryRoot, "scripts/final-cut-filler-removal-headed-e2e.mjs"), "utf8");
  const dialogueRunner = await readFile(join(repositoryRoot, "scripts/final-cut-dialogue-normalization-headed-e2e.mjs"), "utf8");

  assert.ok(fillerRunner.indexOf("canUndo = true") < fillerRunner.indexOf("const continuity ="));
  assert.ok(dialogueRunner.indexOf("canUndo = true") < dialogueRunner.indexOf("const loudness ="));
});
