import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("filler-removal benchmark is wired into local and CI validation", async () => {
  const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const workflow = await readFile(resolve(".github/workflows/typescript.yml"), "utf8");
  const documentation = await readFile(resolve("docs/tests/filler-removal-benchmark.md"), "utf8");

  assert.match(packageJson.scripts?.test ?? "", /tests\/filler-removal\/\*\.test\.ts/);
  assert.equal(packageJson.scripts?.["test:filler-removal"], "tsx --test tests/filler-removal/*.test.ts");
  assert.equal(packageJson.scripts?.["benchmark:filler-removal"], "tsx scripts/run-filler-removal-benchmark.ts");
  assert.match(workflow, /pnpm run benchmark:filler-removal --output-dir artifacts\/filler-removal\/\$\{\{ github\.run_id \}\}/);
  assert.doesNotMatch(workflow, /pnpm run benchmark:filler-removal -- --output-dir/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(documentation, /pnpm run benchmark:filler-removal --output-dir artifacts\/filler-removal\/local-run/);
  assert.match(documentation, /results\.jsonl/);
  assert.match(documentation, /manifest\.json/);
  assert.match(documentation, /95\.0%/);
  assert.match(documentation, /native Final Cut/i);
});
