import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
test("does not introduce an internal Final Cut bundle dependency", async () => {
  const sources = await Promise.all([
    readFile(join(repositoryRoot, "adapters/final-cut/typescript/src/canonical.ts"), "utf8"),
    readFile(join(repositoryRoot, "adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/FinalCutLiveWorkflowExtension.swift"), "utf8"),
  ]);

  for (const source of sources) {
    assert.doesNotMatch(source, /fcpbundle|SQLite/i);
  }
});
