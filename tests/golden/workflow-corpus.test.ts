import assert from "node:assert/strict";
import test from "node:test";
import { loadGoldenCorpus, runGoldenScenario } from "./workflow-corpus-runner.js";

const corpus = loadGoldenCorpus();

test("golden corpus is versioned and covers the supported workflow families", () => {
  assert.equal(corpus.schemaVersion, 1);
  assert.ok(corpus.corpusVersion.length > 0);
  assert.ok(corpus.scenarios.length >= 6);
});

for (const scenario of corpus.scenarios) {
  test(`golden workflow ${scenario.id} has zero silent corruption`, async () => {
    await runGoldenScenario(scenario);
  });
}
