import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const investigationPath = join(repositoryRoot, "docs/architecture/non-ui-timeline-snapshot-investigation.md");

test("records the current-version non-UI snapshot capability decision", async () => {
  const investigation = await readFile(investigationPath, "utf8");

  assert.match(investigation, /Final Cut Pro 10\.7\.1/);
  assert.match(investigation, /No supported non-UI complete timeline snapshot/);
  assert.match(investigation, /com\.apple\.FinalCut\.library\.inspection/);
  assert.match(investigation, /read-only/);
  assert.match(investigation, /ProExtensionHost/);
  assert.match(investigation, /File > Export XML/);
  assert.match(investigation, /FCPXML/);
  assert.match(investigation, /metadata-only/);
});

test("defines the complete snapshot contract and fail-closed boundaries", async () => {
  const investigation = await readFile(investigationPath, "utf8");

  for (const field of [
    "project/sequence identity",
    "media/resource identity",
    "clip occurrences",
    "rational coordinates",
    "roles",
    "storyline relationships",
    "revision",
  ]) {
    assert.match(investigation, new RegExp(field.replace("/", "\\/"), "i"));
  }
  for (const failureMode of [
    "target-bound",
    "partial",
    "CAPABILITY_UNAVAILABLE",
    "fcpbundle",
    "SQLite",
  ]) {
    assert.match(investigation, new RegExp(failureMode, "i"));
  }
  assert.match(investigation, /not.*production source|production source.*not/i);
});

test("does not introduce an internal Final Cut bundle dependency", async () => {
  const sources = await Promise.all([
    readFile(join(repositoryRoot, "adapters/final-cut/typescript/src/canonical.ts"), "utf8"),
    readFile(join(repositoryRoot, "adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/FinalCutLiveWorkflowExtension.swift"), "utf8"),
  ]);

  for (const source of sources) {
    assert.doesNotMatch(source, /fcpbundle|SQLite/i);
  }
});

test("links the decision from canonical Final Cut guidance", async () => {
  const documents = await Promise.all([
    readFile(join(repositoryRoot, "docs/architecture/backend-selection.md"), "utf8"),
    readFile(join(repositoryRoot, "docs/architecture/capability-model.md"), "utf8"),
    readFile(join(repositoryRoot, "docs/mcp/final-cut-live.md"), "utf8"),
  ]);

  for (const document of documents) {
    assert.match(document, /non-ui-timeline-snapshot-investigation\.md/);
  }
});
