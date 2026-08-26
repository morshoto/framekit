import assert from "node:assert/strict";
import test from "node:test";
import { loadGoldenCorpus, runGoldenScenario } from "./workflow-corpus-runner.js";

const corpus = loadGoldenCorpus();

test("golden corpus is versioned and covers the supported workflow families", () => {
  assert.equal(corpus.schemaVersion, 1);
  assert.ok(corpus.corpusVersion.length > 0);
  assert.ok(corpus.scenarios.length >= 6);
});

test("each golden scenario records fixture, operations, and expected evidence", () => {
  for (const scenario of corpus.scenarios) {
    assert.ok(scenario.fixture, `golden scenario ${scenario.id} has no fixture`);
    assert.ok(scenario.operation || scenario.operations, `golden scenario ${scenario.id} has no operation`);
    assert.ok(scenario.expected, `golden scenario ${scenario.id} has no expected evidence`);
  }
});

for (const scenario of corpus.scenarios) {
  test(`golden workflow ${scenario.id} has zero silent corruption`, async () => {
    await runGoldenScenario(scenario);
  });
}
