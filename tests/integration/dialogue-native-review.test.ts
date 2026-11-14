import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { canonicalEvidenceDigest } from "../../scripts/final-cut-evidence.mjs";
import { parseDialogueApproval, previewApprovedDialogue, verifyDialogueReadback, requireDialogueCapabilities } from "../../scripts/final-cut-dialogue-review.mjs";

const policy = { targetLufs: -16, toleranceDb: 0.5, maxTruePeakDb: -1, minGainDb: -6, maxGainDb: 6, minDialogueDurationSeconds: 1 };
const sourceDigest = `sha256:${"a".repeat(64)}`;
async function fixture() {
  const adapter = new InMemoryEditorAdapter({ projectId: "project", projectName: "Disposable dialogue", timelineId: "sequence", timelineName: "Main",
    clips: [{ id: "selected", mediaId: "media", name: "Selected", start: 0, duration: 2, sourceStart: 1, track: 0, gainDb: 2 },
      { id: "reused", mediaId: "media", name: "Reused", start: 2, duration: 2, track: 0, gainDb: 4 }],
    media: [{ mediaId: "media", source: "fixture-source.wav", sourceDigest, mediaKind: "audio", duration: 4 }] });
  const before = await adapter.readProject();
  const approval = { projectId: before.projectId, projectName: before.projectName, sequenceId: before.timeline.id,
    revisionId: before.revision.id, occurrenceId: "selected", candidateCommit: "c".repeat(40), gainDb: 6,
    baselineDigest: canonicalEvidenceDigest(before), sourceDigest, policy };
  const measurement = (snapshot: any, requestId: string, output: string, lufs: number) => ({
    signalScope: "occurrence", valid: true, dialoguePresent: true, integratedLufs: lufs, truePeakDb: -5,
    silenceMs: 0, analyzedDurationSeconds: 2, mediaId: "media", occurrenceId: "selected", revision: snapshot.revision,
    requestedRange: { start: 1, end: 3 }, measuredRange: { start: 1, end: 3 },
    sourceIdentity: { mediaId: "media", source: "fixture-source.wav", sourceDigest },
    provider: { id: "meter", provider: "ffmpeg", version: "1" },
    signalProvenance: { scope: "isolated-occurrence", origin: "editor-export", effectScope: "gain-only", requestId,
      projectId: "project", sequenceId: "sequence", canonicalDigest: canonicalEvidenceDigest(snapshot),
      sequenceRange: { start: 0, end: 2 }, gainDb: snapshot.timeline.clips[0].gainDb,
      outputDigest: `sha256:${output.repeat(64)}`, sampleRate: 48000, sampleCount: 96000,
      exporter: { id: "native-export", provider: "native", version: "1" }, meterVersion: "ffmpeg reference" },
  });
  const preview: any = { previewToken: "approved-preview", expiresAt: new Date(Date.now() + 60000).toISOString(), plan: {
    baseRevision: before.revision, decision: "APPLY", normalizedInput: { mediaId: "media", occurrenceId: "selected", ...policy },
    operations: [{ type: "set-gain", clipId: "selected", gainDb: 6, baseRevision: before.revision }],
    details: { existingGainDb: 2, targetGainDb: 6, clampedGainDb: 4, measurement: measurement(before, "before-export", "b", -20) },
  } };
  const after = structuredClone(before);
  after.timeline.clips[0]!.gainDb = 6;
  after.revision = { ...before.revision, id: "after", sequence: before.revision.sequence + 1 };
  const restored = structuredClone(before);
  restored.revision = { ...before.revision, id: "restored", sequence: before.revision.sequence + 2 };
  const output = measurement(after, "after-export", "d", -16.1);
  return { before, approval, preview, after, restored, output };
}

test("dialogue direct execution requires explicit scoped gain approval", () => {
  assert.throws(() => parseDialogueApproval({}), /DIALOGUE_APPROVAL_REQUIRED/);
  const env = Object.fromEntries(Object.entries({ ALLOW_MUTATION: "1", CANDIDATE_COMMIT: "c".repeat(40), PROJECT: "Disposable",
    PROJECT_ID: "project", SEQUENCE_ID: "sequence", REVISION_ID: "baseline", OCCURRENCE: "selected", APPROVED_GAIN_DB: "6",
    BASELINE_DIGEST: "b".repeat(64), SOURCE_DIGEST: sourceDigest }).map(([key, value]) => [`FRAMEKIT_FINAL_CUT_E2E_${key}`, value]));
  assert.equal(parseDialogueApproval(env).gainDb, 6);
  for (const [key, value] of [["ALLOW_MUTATION", "0"], ["APPROVED_GAIN_DB", ""], ["SOURCE_DIGEST", "unknown"], ["BASELINE_DIGEST", ""]]) {
    assert.throws(() => parseDialogueApproval({ ...env, [`FRAMEKIT_FINAL_CUT_E2E_${key}`]: value }), /DIALOGUE_APPROVAL_REQUIRED/);
  }
  assert.throws(() => parseDialogueApproval({ ...env, FRAMEKIT_DIALOGUE_TOLERANCE_DB: "-1" }), /DIALOGUE_APPROVAL_REQUIRED/);
});

test("single-operation dialogue capability does not require composite transactions", () => {
  const editor = { capabilities: { editor: { canonicalTimelineMode: "canonical-write", timelineSnapshotRead: true, timelineWrite: true,
    readAfterWrite: true, rollback: true, compositeTransactions: false, singleOperationTransactions: true, semanticOperations: { "set-gain": true } }, analyzers: { audioLoudness: true } } };
  requireDialogueCapabilities(editor);
  editor.capabilities.editor.singleOperationTransactions = false;
  assert.throws(() => requireDialogueCapabilities(editor), /CAPABILITY_UNAVAILABLE/);
});

test("approved dialogue preview is read-only and bound to exact gain and actual signal", async () => {
  const f = await fixture(); const calls: any[] = [];
  const result = await previewApprovedDialogue(async (name: string, args: unknown) => { calls.push({ name, args }); return f.preview; }, async () => f.before, f.before, f.approval);
  assert.equal(result.previewToken, "approved-preview");
  assert.deepEqual(calls, [{ name: "skill.preview", args: { skill: "dialogue-normalization", arguments: { baseRevision: f.before.revision, mediaId: "media", occurrenceId: "selected", ...policy } } }]);
});

test("dialogue preview rejects redirected gain, stale state and source-only or malformed measurements", async () => {
  const changes: Array<(f: Awaited<ReturnType<typeof fixture>>) => void> = [
    f => { f.approval.revisionId = "stale"; }, f => { f.approval.baselineDigest = "0".repeat(64); },
    f => { f.preview.plan.operations[0].clipId = "reused"; }, f => { f.preview.plan.operations[0].gainDb = 7; },
    f => { f.preview.plan.normalizedInput.targetLufs = -15; }, f => { f.preview.expiresAt = "2000-01-01"; },
    f => { f.preview.plan.details.measurement.signalScope = "source"; },
    f => { f.preview.plan.details.measurement.signalProvenance.canonicalDigest = "0".repeat(64); },
    f => { f.preview.plan.details.measurement.signalProvenance.gainDb = 0; },
    f => { f.preview.plan.details.measurement.signalProvenance.sampleCount = 10; },
    f => { f.preview.plan.details.measurement.sourceIdentity.sourceDigest = `sha256:${"e".repeat(64)}`; },
    f => { f.preview.plan.details.measurement.measuredRange.start = 0; },
    f => { f.preview.plan.details.measurement.integratedLufs = NaN; },
  ];
  for (const change of changes) {
    const f = await fixture(); change(f);
    await assert.rejects(previewApprovedDialogue(async () => f.preview, async () => f.before, f.before, f.approval), /DIALOGUE_REVIEW_REJECTED/);
  }
  const f = await fixture();
  await assert.rejects(previewApprovedDialogue(async () => f.preview, async () => f.after, f.before, f.approval), /preview changed/);
});

test("dialogue readback requires independent output, exact occurrence diff and full Undo", async () => {
  const f = await fixture();
  const report = verifyDialogueReadback(f.before, f.after, f.restored, f.preview, f.output, f.approval);
  assert.equal(report.output.integratedLufs, -16.1);
  assert.equal(report.restoration.beforeDigest, report.restoration.restoredDigest);
  assert.deepEqual(report.unchangedOccurrenceIds, ["reused"]);
  assert.doesNotMatch(JSON.stringify(report), /fixture-source.wav/);
});

test("dialogue readback rejects predicted levels, unchanged cached output, collateral edits and incomplete Undo", async () => {
  const changes: Array<(f: Awaited<ReturnType<typeof fixture>>) => void> = [
    f => { f.output.integratedLufs = -20; }, f => { f.output.truePeakDb = 0; },
    f => { f.output.signalProvenance.requestId = "before-export"; },
    f => { f.output.signalProvenance.outputDigest = `sha256:${"b".repeat(64)}`; },
    f => { f.output.signalProvenance.exporter.version = "changed"; },
    f => { f.output.provider.version = "changed"; },
    f => { f.output.revision = f.before.revision; },
    f => { f.after.timeline.clips[1]!.gainDb = 6; },
    f => { f.restored.timeline.clips[0]!.gainDb = 6; },
    f => { f.restored.revision = f.before.revision; },
  ];
  for (const change of changes) { const f = await fixture(); change(f); assert.throws(() => verifyDialogueReadback(f.before, f.after, f.restored, f.preview, f.output, f.approval), /DIALOGUE_REVIEW_REJECTED/); }
});

test("direct dialogue runner rejects missing mutation consent before MCP startup", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await assert.rejects(promisify(execFile)(process.execPath, ["scripts/final-cut-dialogue-normalization-headed-e2e.mjs"], {
    env: { ...process.env, FRAMEKIT_FINAL_CUT_E2E_ALLOW_MUTATION: "0", FRAMEKIT_FINAL_CUT_HEADLESS: "1", FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0", FRAMEKIT_FINAL_CUT_EXISTING_SOCKET_ONLY: "1", FRAMEKIT_FINAL_CUT_SOCKET: "/tmp/framekit-test-no-native.sock", FRAMEKIT_FINAL_CUT_E2E_PROJECT: "Disposable", FRAMEKIT_FINAL_CUT_E2E_OCCURRENCE: "selected" },
    timeout: 5000,
  }), /DIALOGUE_APPROVAL_REQUIRED/);
});

test("boolean-only dialogue evidence cannot establish native acceptance", async () => {
  const { sanitizeDialogueNormalizationEvidence } = await import("../../scripts/final-cut-evidence.mjs");
  const { summarizeHeadedEvidence, loadNativeEditingManifest } = await import("../release-gate/native-editing.js");
  const raw = { passed: true, schemaVersion: 1, evidenceType: "headed-native-dialogue-normalization", recordedAt: new Date().toISOString(),
    environment: { framekitVersion: "1", finalCutVersion: "1", gitCommit: "a".repeat(40), nodeVersion: "22", platform: "darwin", architecture: "arm64", osVersion: "Darwin" },
    editor: { name: "Final Cut Pro", version: "1", backend: "final-cut-live" }, capabilities: { editor: { canonicalTimelineMode: "canonical-write" }, analyzers: {} },
    project: { id: "project", name: "Disposable", sequenceId: "sequence", occurrenceId: "selected" },
    target: { project: "Disposable", projectId: "project", sequenceId: "sequence", occurrenceId: "selected" },
    normalization: { status: "VERIFIED", verificationPassed: true, measuredLufs: -20, measuredTruePeakDb: -5, proposedGainDb: 4,
      outputLufs: -30, outputTruePeakDb: 3, toleranceDb: 0.5, maxTruePeakDb: -1, beforeRevision: { id: "before" }, afterRevision: { id: "after" } },
    restoration: { status: "VERIFIED", restored: true, restoredRevision: { id: "restored" } },
    revisions: { before: "before", after: "after", restored: "restored" }, verification: { execute: true, undo: true }, toolResults: [] };
  assert.throws(() => sanitizeDialogueNormalizationEvidence(raw, raw.environment), /dialogue acceptance/);
  assert.throws(() => summarizeHeadedEvidence(raw, loadNativeEditingManifest().workflows.find(w => w.id === "dialogue-normalization")!), /dialogue acceptance/);
});

test("complete dialogue receipt validates measured references and every required scenario", async () => {
  const { dialogueNativeFixture } = await import("../release-gate/dialogue-native-fixture.js");
  const { sanitizeDialogueNormalizationEvidence } = await import("../../scripts/final-cut-evidence.mjs");
  const { validateDialogueNativeAcceptance } = await import("../../scripts/final-cut-dialogue-acceptance.mjs");
  const raw = dialogueNativeFixture();
  raw.acceptance.scenarios[0].privateDiagnostic = "private-sentinel";
  const safe = sanitizeDialogueNormalizationEvidence(raw, raw.environment);
  assert.equal(safe.schemaVersion, 2);
  assert.equal(safe.acceptance.scenarios.length, 20);
  assert.doesNotMatch(JSON.stringify(safe), /private-sentinel/);
  validateDialogueNativeAcceptance(safe);
  const changes: Array<(run: any) => void> = [
    r => { r.passed = false; }, r => { r.acceptance.scenarios.pop(); }, r => { r.acceptance.components[0].observedCommit = "b".repeat(40); },
    r => { r.acceptance.components.find((c: any) => c.name === "audio-meter").descriptor.version = "other"; },
    r => { r.acceptance.scenarios[0].output.integratedLufs = -30; },
    r => { r.acceptance.scenarios[0].output.truePeakDb = 0; },
    r => { r.acceptance.scenarios[0].output.signal.outputDigest = r.acceptance.scenarios[0].input.signal.outputDigest; },
    r => { r.acceptance.scenarios[0].output.signal.requestId = r.acceptance.scenarios[0].input.signal.requestId; },
    r => { r.acceptance.scenarios[0].output.signal.canonicalDigest = r.acceptance.scenarios[0].before.digest; },
    r => { r.acceptance.scenarios[0].restored.gainDb = 4; },
    r => { r.acceptance.scenarios[0].after.unrelatedDigest = "0".repeat(64); },
    r => { r.acceptance.scenarios[0].after.sourceDigest = `sha256:${"0".repeat(64)}`; },
    r => { r.acceptance.scenarios[0].approval.gainDb = 10; },
    r => { r.acceptance.scenarios[0].reference.afterLufs = -20; },
    r => { r.acceptance.scenarios.find((s: any) => s.id === "already-normalized").writeCount = 1; },
    r => { r.acceptance.scenarios.find((s: any) => s.id === "recovery-failure").recovery.writesBlocked = false; },
    r => { r.acceptance.scenarios.find((s: any) => s.id === "stale-preview").reason = "SOME_ERROR"; },
  ];
  for (const change of changes) { const run = dialogueNativeFixture(); change(run); assert.throws(() => validateDialogueNativeAcceptance(run), /dialogue acceptance/); }
});

test("single dialogue probe remains non-passing and retains source/output integrity", async () => {
  const { sanitizeDialogueNormalizationDiagnostic } = await import("../../scripts/final-cut-evidence.mjs");
  const f = await fixture();
  const environment = { framekitVersion: "1", finalCutVersion: "1", gitCommit: f.approval.candidateCommit, nodeVersion: "22", platform: "darwin", architecture: "arm64", osVersion: "Darwin" };
  const raw = { ...f, measurement: f.output, execution: { transactionIds: ["diagnostic-transaction"] }, recordedAt: new Date().toISOString(), editor: { name: "Final Cut Pro", version: "1", backend: "final-cut-live" },
    capabilities: { editor: { canonicalTimelineMode: "canonical-write" }, analyzers: {} }, toolResults: [{ name: "skill.execute", status: "VERIFIED" }, { name: "edit.undo", status: "passed" }],
    sourceIntegrity: Object.fromEntries(["before", "after", "restored"].map(phase => [phase, [{ mediaId: "media", sha256: "a".repeat(64) }]])) };
  const result = sanitizeDialogueNormalizationDiagnostic(raw, environment);
  assert.equal(result.passed, false); assert.equal(result.outcome, "NO_GO");
  assert.match(result.evidenceType, /diagnostic/);
  assert.equal(result.sourceMediaIntegrity.sourceCount, 1);
  assert.equal(result.observation.output.signal.requestId, "after-export");
  raw.sourceIntegrity.after[0]!.sha256 = "b".repeat(64);
  assert.throws(() => sanitizeDialogueNormalizationDiagnostic(raw, environment), /source media hashes changed/);
});
