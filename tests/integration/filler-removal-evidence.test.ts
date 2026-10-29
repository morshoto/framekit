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
  assert.match(runner, /skill\.inspect/);
  assert.match(runner, /skill\.preview/);
  assert.match(runner, /skill\.execute/);
  assert.match(runner, /speechVad/);
  assert.match(runner, /ripple-delete/);
  assert.match(runner, /filler-speech-continuity/);
  assert.match(runner, /edit\.undo/);
  assert.match(runner, /schemaVersion:\s*1/);
  assert.match(runner, /evidenceType:\s*"headed-native-filler-removal"/);
});

test("headed Skill runners arm rollback before validating committed results", async () => {
  const fillerRunner = await readFile(join(repositoryRoot, "scripts/final-cut-filler-removal-headed-e2e.mjs"), "utf8");
  const dialogueRunner = await readFile(join(repositoryRoot, "scripts/final-cut-dialogue-normalization-headed-e2e.mjs"), "utf8");

  assert.ok(fillerRunner.indexOf("canUndo = true") < fillerRunner.indexOf("const continuity ="));
  assert.ok(dialogueRunner.indexOf("canUndo = true") < dialogueRunner.indexOf("const loudness ="));
});
