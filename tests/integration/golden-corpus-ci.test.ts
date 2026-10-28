import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("the CI test command runs the versioned golden workflow corpus", async () => {
  const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
    scripts?: { test?: string };
  };
  const documentation = await readFile(resolve("docs/tests/golden-corpus.md"), "utf8").catch(() => "");
  const testRunner = await readFile(resolve("scripts/run-tests-with-isolated-home.mjs"), "utf8");

  assert.equal(packageJson.scripts?.test, "node scripts/run-tests-with-isolated-home.mjs");
  assert.match(testRunner, /"tests\/golden"/);
  assert.match(documentation, /pnpm run test:golden/);
  assert.match(documentation, /zero silent corruption/);
});
