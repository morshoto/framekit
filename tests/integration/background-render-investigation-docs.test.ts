import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const investigationPath = join(repositoryRoot, "docs/final-cut/background-render-export-investigation.md");

async function readInvestigation(): Promise<string> {
  return readFile(investigationPath, "utf8");
}

test("background render investigation records the current native decision", async () => {
  const documentation = await readInvestigation();

  assert.match(documentation, /# Background Final Cut Render and Export Investigation/);
  assert.match(documentation, /Issue: \[#262\]/);
  assert.match(documentation, /Status: Decision recorded/);
  assert.match(documentation, /Final Cut Pro 10\.7\.1/);
  assert.match(documentation, /No supported background-native Final Cut render or export provider/);
  assert.match(documentation, /headed-only/);
});

test("background render investigation distinguishes provider candidates", async () => {
  const documentation = await readInvestigation();

  for (const candidate of [
    "Final Cut background rendering",
    "Current Final Cut Apple Events",
    "Workflow Extension",
    "Managed FCPXML artifact",
    "External renderer",
  ]) assert.match(documentation, new RegExp(candidate));
  assert.match(documentation, /artifact-rendered/);
  assert.match(documentation, /external-rendered/);
  assert.match(documentation, /must not.*native|native.*must not/i);
});

test("background render investigation defines the safe job contract", async () => {
  const documentation = await readInvestigation();

  for (const requirement of [
    "source target",
    "revision",
    "digest",
    "preset",
    "progress",
    "cancellation",
    "timeout",
    "staging",
    "atomic",
    "ffprobe",
    "provenance",
  ]) assert.match(documentation, new RegExp(requirement, "i"));
  assert.match(documentation, /overwrite/);
  assert.match(documentation, /unverified output.*complete|complete.*unverified output/i);
});

test("background render investigation is linked from Final Cut and architecture indexes", async () => {
  const finalCutReadme = await readFile(join(repositoryRoot, "docs/final-cut/README.md"), "utf8");
  const architectureReadme = await readFile(join(repositoryRoot, "docs/architecture/README.md"), "utf8");

  assert.match(finalCutReadme, /\[Background render and export investigation\]\(\.\/background-render-export-investigation\.md\)/);
  assert.match(architectureReadme, /\[Background render and export investigation\]\(\.\/background-render-export-investigation\.md\)/);
});
