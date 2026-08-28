import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("headed filler-removal runner covers live preflight, verification, and rollback", async () => {
  const runner = await readFile(join(repositoryRoot, "scripts/final-cut-filler-removal-headed-e2e.mjs"), "utf8");

  assert.match(runner, /canonical-write/);
  assert.match(runner, /editor\.live\.inspect/);
  assert.match(runner, /speech\.filler\.remove\.preview/);
  assert.match(runner, /speech\.filler\.remove\.execute/);
  assert.match(runner, /filler-speech-continuity/);
  assert.match(runner, /edit\.undo/);
  assert.match(runner, /schemaVersion:\s*1/);
  assert.match(runner, /evidenceType:\s*"headed-native-filler-removal"/);
});

test("headed filler-removal evidence documentation keeps live and deterministic proof separate", async () => {
  const documentation = await readFile(join(repositoryRoot, "docs/tests/final-cut-filler-removal-e2e.md"), "utf8");

  assert.match(documentation, /FRAMEKIT_FINAL_CUT_E2E_PROJECT/);
  assert.match(documentation, /FRAMEKIT_SPEECH_ANALYZER/);
  assert.match(documentation, /canonical-write/);
  assert.match(documentation, /metadata-only/);
  assert.match(documentation, /deterministic/);
  assert.match(documentation, /private media/);
});
