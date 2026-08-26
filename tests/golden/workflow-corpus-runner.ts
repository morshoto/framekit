import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AgentVideoRuntime, type ContextRevision, type EditOperation, type ProjectSnapshot, type TimelineDiff, type WorkflowOperation } from "@framekit/runtime";
import { InMemoryEditorAdapter, type InMemoryFixture } from "@framekit/testkit";

export interface GoldenScenario {
  id: string;
  family: string;
  description: string;
  mode: "single" | "composite";
  fixture: InMemoryFixture;
  operation?: EditOperation;
  operations?: WorkflowOperation[];
  expected: GoldenExpected;
}

export interface GoldenExpected {
  before: ProjectSnapshot;
  after: ProjectSnapshot;
  diff: TimelineDiff;
  afterRevision: ContextRevision;
  undoRevision: ContextRevision;
}

export interface GoldenCorpus {
  schemaVersion: number;
  corpusVersion: string;
  runtimeContract: string;
  scenarios: GoldenScenario[];
}

const corpusPath = fileURLToPath(new URL("./corpus.json", import.meta.url));

export function loadGoldenCorpus(): GoldenCorpus {
  const parsed: unknown = JSON.parse(readFileSync(corpusPath, "utf8"));
  assertCorpus(parsed);
  return parsed;
}

export async function runGoldenScenario(scenario: GoldenScenario): Promise<void> {
  assert.match(scenario.id, /^(phase0|phase1)\./, `invalid golden scenario id: ${scenario.id}`);
  assert.ok(scenario.family.length > 0, `golden scenario ${scenario.id} has no family`);
  assert.ok(scenario.description.length > 0, `golden scenario ${scenario.id} has no description`);
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter(scenario.fixture));
  const before = await runtime.inspectProject();
  assert.deepEqual(before, scenario.expected.before, `${scenario.id}: before snapshot mismatch`);

  let transaction;
  if (scenario.mode === "single") {
    assert.ok(scenario.operation, `${scenario.id}: single scenario has no operation`);
    transaction = await runtime.edit(scenario.operation);
  } else {
    assert.ok(scenario.operations, `${scenario.id}: composite scenario has no operations`);
    const preview = await runtime.previewEdit({ baseRevision: before.revision, operations: scenario.operations });
    assert.deepEqual(preview.expectedDiff, scenario.expected.diff, `${scenario.id}: preview diff mismatch`);
    transaction = await runtime.executeEdit(preview.previewToken);
  }

  assert.equal(transaction.status, "VERIFIED", `${scenario.id}: workflow was not verified`);
  assert.deepEqual(transaction.after, scenario.expected.after, `${scenario.id}: after snapshot mismatch`);
  assert.deepEqual(transaction.diff, scenario.expected.diff, `${scenario.id}: diff mismatch`);
  assert.deepEqual(transaction.after.revision, scenario.expected.afterRevision, `${scenario.id}: after revision mismatch`);
  assert.deepEqual(await runtime.inspectProject(), scenario.expected.after, `${scenario.id}: read-after-write mismatch`);

  const undone = await runtime.undo(transaction.id);
  assert.deepEqual(undone, { ...scenario.expected.before, revision: scenario.expected.undoRevision }, `${scenario.id}: undo snapshot mismatch`);
}

function assertCorpus(value: unknown): asserts value is GoldenCorpus {
  assert.ok(value && typeof value === "object", "golden corpus must be an object");
  const corpus = value as Partial<GoldenCorpus>;
  assert.equal(corpus.schemaVersion, 1, "unsupported golden corpus schema");
  assert.equal(typeof corpus.corpusVersion, "string", "golden corpus version is required");
  assert.equal(typeof corpus.runtimeContract, "string", "golden corpus runtime contract is required");
  assert.ok(Array.isArray(corpus.scenarios), "golden corpus scenarios are required");

  const ids = new Set<string>();
  for (const scenario of corpus.scenarios) {
    assert.ok(scenario && typeof scenario === "object", "golden scenario must be an object");
    assert.equal(typeof scenario.id, "string", "golden scenario id is required");
    assert.equal(typeof scenario.family, "string", `golden scenario ${scenario.id} family is required`);
    assert.equal(typeof scenario.description, "string", `golden scenario ${scenario.id} description is required`);
    assert.ok(scenario.mode === "single" || scenario.mode === "composite", `golden scenario ${scenario.id} mode is invalid`);
    assert.ok(scenario.fixture && typeof scenario.fixture === "object", `golden scenario ${scenario.id} fixture is required`);
    assert.ok(scenario.operation || scenario.operations, `golden scenario ${scenario.id} operation is required`);
    assert.ok(scenario.expected && typeof scenario.expected === "object", `golden scenario ${scenario.id} expected evidence is required`);
    assert.equal(ids.has(scenario.id), false, `duplicate golden scenario id: ${scenario.id}`);
    ids.add(scenario.id);
  }
}
