import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface GoldenScenario {
  id: string;
  family: string;
  description: string;
  [key: string]: unknown;
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
    assert.equal(ids.has(scenario.id), false, `duplicate golden scenario id: ${scenario.id}`);
    ids.add(scenario.id);
  }
}
