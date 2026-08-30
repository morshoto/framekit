import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("release gate is wired into local and CI validation", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };
  const workflow = await readFile(".github/workflows/typescript.yml", "utf8");

  assert.match(packageJson.scripts?.test ?? "", /tests\/release-gate\/\*\.test\.ts/);
  assert.equal(packageJson.scripts?.["test:release-gate"], "tsx --test tests/release-gate/*.test.ts");
  assert.equal(packageJson.scripts?.["release-gate"], "tsx scripts/run-release-gate.ts");
  assert.match(workflow, /pnpm run release-gate --output-dir artifacts\/release-gate\/\$\{\{ github\.run_id \}\}/);
  assert.match(workflow, /name: release-gate-\$\{\{ github\.run_id \}\}/);
  assert.match(workflow, /path: artifacts\/release-gate\/\$\{\{ github\.run_id \}\}/);
});
