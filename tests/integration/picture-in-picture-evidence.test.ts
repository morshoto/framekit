import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("headed PIP runner preserves native evidence boundaries", async () => {
  const runner = await readFile(join(process.cwd(), "scripts/final-cut-picture-in-picture-headed-e2e.mjs"), "utf8");
  assert.match(runner, /editor\.native\.picture-in-picture\.preview/);
  assert.match(runner, /editor\.native\.picture-in-picture\.execute/);
  assert.match(runner, /editor\.native\.undo/);
  assert.match(runner, /headed-native-picture-in-picture/);
  assert.match(runner, /FRAMEKIT_FINAL_CUT_E2E_ANCHOR_QUERY/);
  assert.match(runner, /FRAMEKIT_FINAL_CUT_E2E_PIP_QUERY/);
  assert.match(runner, /observed.*position/);
  assert.match(runner, /observed.*frame/);
  assert.doesNotMatch(runner, /masking|cutout|tracking/);
});

test("PIP documentation separates canonical, artifact, and headed-native evidence", async () => {
  const documentation = await readFile(join(process.cwd(), "docs/final-cut/picture-in-picture.md"), "utf8");
  assert.match(documentation, /Fixture evidence/);
  assert.match(documentation, /FCPXML evidence/);
  assert.match(documentation, /Headed-native evidence/);
  assert.match(documentation, /masking, tracking/);
  assert.match(documentation, /test:final-cut-pip-headed/);
});
