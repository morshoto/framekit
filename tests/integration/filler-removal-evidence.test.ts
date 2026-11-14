import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeFillerRemovalEvidence } from "../../scripts/final-cut-evidence.mjs";
import { fillerNativeEvidence } from "../release-gate/filler-native-fixture.js";
import { loadNativeEditingManifest, summarizeHeadedEvidence } from "../release-gate/native-editing.js";

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
  ];
  for (const mutate of mutations) {
    const raw = fillerNativeEvidence(); mutate(raw);
    assert.throws(() => sanitizeFillerRemovalEvidence(raw, raw.environment), /filler/i);
    assert.throws(() => summarizeHeadedEvidence(raw, workflow), /filler/i);
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
