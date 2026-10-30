import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("the CI test command runs the versioned golden workflow corpus", async () => {
  const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
    scripts?: { test?: string };
  };
  const documentation = await readFile(resolve("docs/testing.md"), "utf8");
  const testRunner = await readFile(resolve("scripts/run-tests-with-isolated-home.mjs"), "utf8");
  const suiteManifest = JSON.parse(await readFile(resolve("scripts/test-suite-manifest.json"), "utf8")) as {
    tests: Array<{ path: string; tags: string[] }>;
  };

  assert.equal(packageJson.scripts?.test, "node scripts/run-tests-with-isolated-home.mjs");
  assert.match(testRunner, /selectTestFiles/);
  assert.ok(suiteManifest.tests.some(({ path, tags }) => path.startsWith("tests/golden/") && tags.includes("fixture-e2e")));
  assert.match(documentation, /pnpm run test:golden/);
  assert.match(documentation, /zero silent corruption/);
});
