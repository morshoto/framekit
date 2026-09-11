import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("headed native masking evidence has an opt-in sanitized runner", async () => {
  const root = process.cwd();
  const [packageJson, runner, liveDocs, toolsDocs, capabilityDocs] = await Promise.all([
    readFile(join(root, "package.json"), "utf8").then((value) => JSON.parse(value)),
    readFile(join(root, "scripts/final-cut-masking-headed-e2e.mjs"), "utf8"),
    readFile(join(root, "docs/tests/final-cut-live-e2e.md"), "utf8"),
    readFile(join(root, "docs/mcp/tools.md"), "utf8"),
    readFile(join(root, "docs/architecture/capability-model.md"), "utf8"),
  ]);

  assert.equal(packageJson.scripts["test:final-cut-masking-headed"], "node scripts/final-cut-masking-headed-e2e.mjs");
  assert.match(runner, /FRAMEKIT_FINAL_CUT_E2E_PROJECT/);
  assert.match(runner, /FRAMEKIT_FINAL_CUT_E2E_MASK_QUERY/);
  assert.match(runner, /editor\.native\.mask\.preview/);
  assert.match(runner, /editor\.native\.mask\.execute/);
  assert.match(runner, /editor\.native\.undo/);
  assert.match(runner, /headed-native-mask-placement/);
  assert.match(runner, /observedMask/);
  assert.match(runner, /allowlisted|sanitized/i);
  assert.doesNotMatch(runner, /JSON\.stringify\((inspected|before|after|executed|undone)\)/);
  assert.match(liveDocs, /test:final-cut-masking-headed/);
  assert.match(liveDocs, /headed-native-mask-placement/);
  assert.match(toolsDocs, /timeline\.mask\.add\.preview/);
  assert.match(toolsDocs, /editor\.native\.mask\.execute/);
  assert.match(capabilityDocs, /supplied-alpha/);
  assert.match(capabilityDocs, /person cutout/);
});
