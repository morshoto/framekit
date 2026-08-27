import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";

test("headed filler-removal runner covers live preflight, verification, and rollback", async () => {
  const runner = await readFile(join(process.cwd(), "scripts/final-cut-filler-removal-headed-e2e.mjs"), "utf8");

  assert.match(runner, /canonical-write/);
  assert.match(runner, /editor\.live\.inspect/);
  assert.match(runner, /speech\.filler\.remove\.preview/);
  assert.match(runner, /speech\.filler\.remove\.execute/);
  assert.match(runner, /filler-speech-continuity/);
  assert.match(runner, /edit\.undo/);
  assert.match(runner, /JSON\.stringify\(evidence, null, 2\)/);
});

test("headed filler-removal evidence documentation keeps live and deterministic proof separate", async () => {
  const documentation = await readFile(join(process.cwd(), "docs/tests/final-cut-filler-removal-e2e.md"), "utf8");

  assert.match(documentation, /FRAMEKIT_FINAL_CUT_E2E_PROJECT/);
  assert.match(documentation, /FRAMEKIT_SPEECH_ANALYZER/);
  assert.match(documentation, /canonical-write/);
  assert.match(documentation, /metadata-only/);
  assert.match(documentation, /deterministic/);
  assert.match(documentation, /private media/);
});
