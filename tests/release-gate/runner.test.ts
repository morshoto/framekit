import assert from "node:assert/strict";
import test from "node:test";
import { loadReleaseGateCorpus, runReleaseGate } from "./runner.js";

test("release gate corpus carries controlled fixtures for every workflow", () => {
  const corpus = loadReleaseGateCorpus();

  assert.equal(corpus.schemaVersion, 1);
  assert.ok(corpus.workflows.length >= 15);
  for (const workflow of corpus.workflows) {
    assert.ok(workflow.fixture, `${workflow.id} has no controlled fixture`);
    assert.ok(workflow.family === "filler-removal" || workflow.family === "dialogue-normalization");
  }
});

test("release gate executes Skills and separates capability evidence", async () => {
  const report = await runReleaseGate({ generatedAt: "2026-08-30T00:00:00.000Z" });

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.gate, "v0.1.6-native-editing");
  assert.equal(report.manifestVersion, "2026-09-11");
  assert.equal(report.deterministic.passed, true);
  assert.ok(report.deterministic.workflows.length >= 15);
  assert.equal(report.adapter.backend, "fixture");
  assert.equal(report.adapter.fixtureEvidence, true);
  assert.equal(report.live.status, "unsupported");
  assert.ok(report.live.reason.length > 0);
  assert.ok(report.unsupportedCapabilities.length > 0);
  assert.equal(report.evidenceTiers.deterministic.status, "verified");
  assert.equal(report.evidenceTiers["fcpxml-artifact"].status, "verified");
  assert.equal(report.evidenceTiers["metadata-only"].status, "verified");
  assert.equal(report.evidenceTiers["canonical-live"].status, "unsupported");
  assert.equal(report.evidenceTiers["headed-native"].status, "unrun");
  assert.equal(report.generatedAt, "2026-08-30T00:00:00.000Z");
});
