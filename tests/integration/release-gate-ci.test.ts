import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("release gate is wired into local and CI validation", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };
  const workflow = await readFile(".github/action/test/action.yml", "utf8");
  const runner = await readFile("scripts/release/run-release-gate.ts", "utf8");
  const compatibilityRunner = await readFile("scripts/run-release-gate.ts", "utf8");
  const testRunner = await readFile("scripts/run-tests-with-isolated-home.mjs", "utf8");
  const suiteManifest = JSON.parse(await readFile("scripts/test-suite-manifest.json", "utf8")) as {
    tests: Array<{ path: string; tags: string[] }>;
  };

  assert.equal(packageJson.scripts?.test, "node scripts/run-tests-with-isolated-home.mjs");
  assert.match(testRunner, /selectTestFiles/);
  assert.ok(suiteManifest.tests.some(({ path, tags }) => path.startsWith("tests/release-gate/") && tags.includes("release-gate")));
  assert.equal(packageJson.scripts?.["test:release-gate"], "node scripts/run-tests-with-isolated-home.mjs release-gate");
  assert.equal(packageJson.scripts?.["release-gate"], "tsx scripts/release/run-release-gate.ts");
  assert.match(compatibilityRunner, /\.\/release\/run-release-gate\.js/);
  assert.equal(packageJson.scripts?.["verify-release-provenance"], "tsx scripts/verify-release-provenance.ts");
  assert.match(workflow, /name: Run v0\.1\.6 native-editing release gate/);
  assert.match(runner, /runRepositoryChecks/);
  assert.match(runner, /repositoryChecks/);
  assert.match(workflow, /pnpm run release-gate --output-dir artifacts\/release-gate\/\$\{\{ github\.run_id \}\}/);
  assert.match(workflow, /name: release-gate-\$\{\{ github\.run_id \}\}/);
  assert.match(workflow, /path: artifacts\/release-gate\/\$\{\{ github\.run_id \}\}/);
});
