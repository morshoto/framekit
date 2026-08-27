import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import {
  FILLER_REMOVAL_VERIFICATION_THRESHOLD,
  loadFillerRemovalCorpus,
  runFillerRemovalBenchmark,
  summarizeFillerRemovalResults,
  type FillerRemovalRawResult,
} from "./benchmark.js";
import { writeFillerRemovalArtifacts } from "./artifacts.js";

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
  const rawResults = report.scenarios.map(({ scenarioId, category, expectedOutcome, actualOutcome, passed, workflow, failure }) => ({
    scenarioId,
    category,
    expectedOutcome,
    actualOutcome,
    passed,
    workflow,
    failure,
  } satisfies FillerRemovalRawResult));

  assert.deepEqual(summarizeFillerRemovalResults(rawResults), report.summary);
});

test("filler-removal artifacts retain raw results and refuse overwrites", async () => {
  const report = await runFillerRemovalBenchmark({ generatedAt: "2026-08-28T00:00:00.000Z" });
  const root = await mkdtemp(join(os.tmpdir(), "framekit-filler-removal-"));
  const outputDirectory = join(root, "run");

  const artifacts = await writeFillerRemovalArtifacts(report, outputDirectory);
  const raw = await readFile(artifacts.resultsPath, "utf8");
  const manifest = JSON.parse(await readFile(artifacts.manifestPath, "utf8")) as {
    schemaVersion: number;
    benchmark: string;
    corpusDigest: string;
    configuration: unknown;
    resultCount: number;
    resultSha256: string;
    summary: unknown;
  };

  assert.equal(raw.trim().split("\n").length, report.scenarios.length);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.benchmark, "filler-removal");
  assert.equal(manifest.corpusDigest, report.corpusDigest);
  assert.deepEqual(manifest.configuration, report.configuration);
  assert.equal(manifest.resultCount, report.scenarios.length);
  assert.equal(manifest.resultSha256, createHash("sha256").update(raw).digest("hex"));
  assert.deepEqual(manifest.summary, report.summary);
  await assert.rejects(
    writeFillerRemovalArtifacts(report, outputDirectory),
    /FILLER_REMOVAL_ARTIFACT_EXISTS/,
  );
});
