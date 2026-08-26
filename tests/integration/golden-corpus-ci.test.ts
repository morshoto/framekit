import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("the CI test command runs the versioned golden workflow corpus", async () => {
  const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
    scripts?: { test?: string };
  };
  const documentation = await readFile(resolve("docs/tests/golden-corpus.md"), "utf8").catch(() => "");

  assert.match(packageJson.scripts?.test ?? "", /tests\/golden\/\*\.test\.ts/);
  assert.match(documentation, /pnpm run test:golden/);
  assert.match(documentation, /zero silent corruption/);
});
