import assert from "node:assert/strict";
import test from "node:test";
import {
  loadV0112AcceptanceCorpus,
  renderV0112AcceptanceReport,
  runV0112Acceptance,
} from "./v0112-acceptance.js";

test("v0.1.12 acceptance corpus covers closed-loop success and recovery cases", () => {
  const corpus = loadV0112AcceptanceCorpus();

  assert.equal(corpus.schemaVersion, 1);
  assert.equal(corpus.releaseVersion, "0.1.12");
  assert.equal(corpus.projectPolicy.disposable, true);
  assert.equal(corpus.projectPolicy.privateMediaAllowed, false);
  assert.ok(corpus.scenarios.length >= 15);
  assert.ok(corpus.scenarios.some((scenario) => scenario.family === "filler-removal"));
  assert.ok(corpus.scenarios.some((scenario) => scenario.family === "dialogue-normalization"));
  assert.ok(corpus.scenarios.some((scenario) => scenario.expectedOutcome === "rolled-back"));
  assert.ok(corpus.negativeCases.includes("provider-unavailable"));
  assert.ok(corpus.negativeCases.includes("stale-revision"));
  assert.ok(corpus.negativeCases.includes("ambiguous-target"));
});

test("v0.1.12 acceptance report retains tier and revision evidence", async () => {
  const report = await runV0112Acceptance({ generatedAt: "2026-09-17T00:00:00.000Z" });

  assert.equal(report.releaseVersion, "0.1.12");
  assert.equal(report.deterministic.passed, true);
  assert.ok(report.deterministic.fillerVerificationRate >= 0.95);
  assert.ok(report.results.every((result) => result.evidenceTier === "deterministic"));
  assert.ok(report.results.every((result) => result.sourceRevision.length > 0));
  assert.ok(report.results.some((result) => result.expectedOutcome === "rolled-back" && result.recovery === "restored"));
  assert.equal(report.canonicalLive.status, "unsupported");
  assert.equal(report.headedNative.status, "unrun");
  assert.match(renderV0112AcceptanceReport(report), /v0\.1\.12 acceptance/);
  assert.match(renderV0112AcceptanceReport(report), /headed_native=unrun/);
});
