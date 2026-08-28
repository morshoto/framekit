import assert from "node:assert/strict";
import test from "node:test";
import { loadGoldenCorpus, runGoldenScenario, validateGoldenSnapshot } from "./workflow-corpus-runner.js";

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
    assert.ok((scenario.expected as { before?: unknown }).before, `golden scenario ${scenario.id} has no expected before snapshot`);
    assert.ok((scenario.expected as { after?: unknown }).after, `golden scenario ${scenario.id} has no expected after snapshot`);
    assert.ok((scenario.expected as { diff?: unknown }).diff, `golden scenario ${scenario.id} has no expected diff`);
    assert.ok((scenario.expected as { rollbackRevision?: unknown }).rollbackRevision, `golden scenario ${scenario.id} has no rollback revision`);
    assert.equal((scenario.expected as { staleErrorCode?: unknown }).staleErrorCode, "STALE_CONTEXT", `golden scenario ${scenario.id} has no stale-write diagnostic`);
  }
});

test("golden structural validation rejects unresolved media references", () => {
  const scenario = corpus.scenarios.find((candidate) => candidate.mode === "single")!;
  const invalid = structuredClone(scenario.expected.before);
  invalid.timeline.clips[0]!.mediaId = "missing-media";

  assert.throws(
    () => validateGoldenSnapshot(invalid, scenario.id),
    new RegExp(`${scenario.id}.*media reference`),
  );
});

test("golden structural validation rejects inconsistent rational timing", () => {
  const scenario = corpus.scenarios.find((candidate) => candidate.id === "phase1.ripple-delete")!;
  const invalid = structuredClone(scenario.expected.before);
  invalid.timeline.clips[0]!.durationTime = { value: "999", timescale: "1" };

  assert.throws(
    () => validateGoldenSnapshot(invalid, scenario.id),
    new RegExp(`${scenario.id}.*durationTime disagrees with duration`),
  );
});

test("golden structural validation accepts equivalent non-terminating rational timing", () => {
  const scenario = corpus.scenarios.find((candidate) => candidate.id === "phase1.ripple-delete")!;
  const valid = structuredClone(scenario.expected.before);
  valid.timeline.clips[0]!.start = 1 / 3;
  valid.timeline.clips[0]!.startTime = { value: "1", timescale: "3" };
  valid.timeline.storyElements[0]!.start = 1 / 3;
  valid.timeline.storyElements[0]!.startTime = { value: "1", timescale: "3" };

  assert.doesNotThrow(() => validateGoldenSnapshot(valid, scenario.id));
});

for (const scenario of corpus.scenarios) {
  test(`golden workflow ${scenario.id} has zero silent corruption`, async () => {
    await runGoldenScenario(scenario);
  });
}
