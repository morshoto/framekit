import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("Renovate branches receive the chore label", async () => {
  const branchLabels = await readFile(resolve(repository, ".github/labels/labeling-branch.yaml"), "utf8");
  const choreRule = branchLabels.match(/^'Type: Chore':\n([\s\S]*?)(?=^'|\s*$)/m)?.[1];

  assert.ok(choreRule, "Type: Chore branch-label rule should be present");
  assert.match(choreRule, /^\s+- head-branch: \['\^renovate\/\'\]$/m);
});
