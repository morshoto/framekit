import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const boundaryDocumentPath = join(repositoryRoot, "docs/architecture/final-cut-provider-boundaries.md");

async function readBoundaryDocument(): Promise<string> {
  return readFile(boundaryDocumentPath, "utf8");
}

test("provider boundary documentation names each independent Final Cut surface", async () => {
  const documentation = await readBoundaryDocument();

  assert.match(documentation, /# Final Cut Provider Boundaries/);
  assert.match(documentation, /Issue: \[#248\]/);
  assert.match(documentation, /Background library inspection/);
  assert.match(documentation, /FinalCutBackgroundCatalogProvider/);
  assert.match(documentation, /Canonical timeline snapshot/);
  assert.match(documentation, /FinalCutCanonicalSnapshotSource/);
  assert.match(documentation, /Native UI writes/);
  assert.match(documentation, /NativeFinalCutEditor/);
});

test("provider routing documents evidence guarantees without upgrades", async () => {
  const documentation = await readBoundaryDocument();

  assert.match(documentation, /`project\.list`[\s\S]*background/);
  assert.match(documentation, /`project\.inspect`[\s\S]*canonical/);
  assert.match(documentation, /`editing\.route`[\s\S]*canonical/);
  assert.match(documentation, /`artifact\.edit`[\s\S]*artifact/);
  for (const guarantee of ["observed", "metadata-only", "canonical-read", "canonical-write", "native-verified", "fcpxml-artifact"]) {
    assert.match(documentation, new RegExp(guarantee));
  }
  assert.match(documentation, /must not.*canonical|canonical.*must not/i);
  assert.match(documentation, /CAPABILITY_UNAVAILABLE/);
});

test("background and native safety requirements are explicit", async () => {
  const documentation = await readBoundaryDocument();

  for (const forbiddenBackgroundAction of ["System Events", "click", "keystroke", "project selection"]) {
    assert.match(documentation, new RegExp(forbiddenBackgroundAction, "i"));
  }
  for (const nativeSafetyRequirement of ["frontmost", "timeline focus", "preview", "readback", "revision", "Undo"]) {
    assert.match(documentation, new RegExp(nativeSafetyRequirement, "i"));
  }
  assert.match(documentation, /fcpbundle[\s\S]*SQLite|SQLite[\s\S]*fcpbundle/i);
});

test("provider boundary documentation is linked from architecture and Final Cut indexes", async () => {
  const documentation = await readBoundaryDocument();
  const [architectureIndex, finalCutIndex, capabilityModel, mcpCapabilities] = await Promise.all([
    readFile(join(repositoryRoot, "docs/architecture/README.md"), "utf8"),
    readFile(join(repositoryRoot, "docs/final-cut/README.md"), "utf8"),
    readFile(join(repositoryRoot, "docs/architecture/capability-model.md"), "utf8"),
    readFile(join(repositoryRoot, "docs/mcp/capabilities-and-errors.md"), "utf8"),
  ]);

  assert.match(documentation, /non-ui-timeline-snapshot-investigation\.md/);
  assert.match(documentation, /native-write-undo-investigation\.md/);
  assert.match(architectureIndex, /final-cut-provider-boundaries\.md/);
  assert.match(finalCutIndex, /final-cut-provider-boundaries\.md/);
  assert.match(capabilityModel, /final-cut-provider-boundaries\.md/);
  assert.match(mcpCapabilities, /\.\.\/architecture\/final-cut-provider-boundaries\.md/);
});
