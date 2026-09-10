import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("publisher headed E2E is a separate FCPXML workflow", async () => {
  const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const publisherRunner = await readFile(join(repositoryRoot, "scripts/final-cut-publisher-headed-e2e.mjs"), "utf8");
  const nativeRunner = await readFile(join(repositoryRoot, "scripts/final-cut-disposable-native-headed-e2e.mjs"), "utf8");

  assert.equal(typeof packageJson.scripts?.["test:final-cut-publisher-headed"], "string");
  assert.match(publisherRunner, /FRAMEKIT_FINAL_CUT_E2E_FCPXML_PATH/);
  assert.match(publisherRunner, /FRAMEKIT_FCPXML_PATH/);
  assert.match(publisherRunner, /artifact\.inspect/);
  assert.match(publisherRunner, /artifact\.publish/);
  assert.match(publisherRunner, /editor\.live\.inspect/);
  assert.match(publisherRunner, /confirm: true/);
  assert.equal(publisherRunner.includes("editor.native."), false);
  assert.equal(nativeRunner.includes("artifact.publish"), false);
  assert.match(nativeRunner, /FRAMEKIT_FCPXML_PATH: ""/);
});
