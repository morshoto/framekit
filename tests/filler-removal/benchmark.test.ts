import assert from "node:assert/strict";
import test from "node:test";
import {
  FILLER_REMOVAL_VERIFICATION_THRESHOLD,
  loadFillerRemovalCorpus,
  runFillerRemovalBenchmark,
  summarizeFillerRemovalResults,
  type FillerRemovalRawResult,
} from "./benchmark.js";

test("filler-removal corpus is versioned and includes representative failure cases", () => {
  const corpus = loadFillerRemovalCorpus();

  assert.equal(corpus.schemaVersion, 1);
  assert.match(corpus.corpusVersion, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(corpus.scenarios.length >= 6);
  assert.ok(corpus.scenarios.some((scenario) => scenario.category === "success"));
  assert.ok(corpus.scenarios.some((scenario) => scenario.category === "boundary"));
  assert.ok(corpus.scenarios.some((scenario) => scenario.category === "rollback"));
  assert.equal(new Set(corpus.scenarios.map((scenario) => scenario.id)).size, corpus.scenarios.length);
});

test("filler-removal benchmark runs planning, edit, re-observation, and transcript verification", async () => {
  const report = await runFillerRemovalBenchmark({ generatedAt: "2026-08-28T00:00:00.000Z" });

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.metric, "successful-verification-rate");
  assert.ok(report.scenarios.length >= 6);
  assert.ok(report.scenarios.every((scenario) => scenario.workflow.planned));
  assert.ok(report.scenarios.every((scenario) => scenario.workflow.edited));
  assert.ok(report.scenarios.every((scenario) => scenario.workflow.reObserved));
  assert.ok(report.scenarios.every((scenario) => scenario.workflow.transcriptVerified));
  assert.equal(report.summary.threshold.minimum, FILLER_REMOVAL_VERIFICATION_THRESHOLD);
  assert.equal(report.summary.threshold.passed, true);
  assert.ok(report.summary.verificationSuccessRate >= FILLER_REMOVAL_VERIFICATION_THRESHOLD);
  assert.equal(report.summary.failureCategories.boundary, 1);
  assert.equal(report.summary.failureCategories.rollback, 1);
  assert.ok(report.scenarios.every((scenario) => scenario.scenarioId.length > 0));
});

test("filler-removal verification metric is reproducible from raw results", async () => {
  const report = await runFillerRemovalBenchmark({ generatedAt: "2026-08-28T00:00:00.000Z" });
  const rawResults = report.scenarios.map(({ scenarioId, expectedOutcome, actualOutcome, passed, workflow, failure }) => ({
    scenarioId,
    expectedOutcome,
    actualOutcome,
    passed,
    workflow,
    failure,
  } satisfies FillerRemovalRawResult));

  assert.deepEqual(summarizeFillerRemovalResults(rawResults), report.summary);
});
