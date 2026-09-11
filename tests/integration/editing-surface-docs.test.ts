import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("editing surface docs distinguish artifact, publish, and live targets", async () => {
  const compatibility = await readFile(join(repositoryRoot, "docs/COMPATIBILITY.md"), "utf8");
  const backendSelection = await readFile(join(repositoryRoot, "docs/architecture/backend-selection.md"), "utf8");
  const mcpTools = await readFile(join(repositoryRoot, "docs/mcp/tools.md"), "utf8");
  const finalCutInstallation = await readFile(join(repositoryRoot, "docs/final-cut/installation.md"), "utf8");
  const finalCutLive = await readFile(join(repositoryRoot, "docs/mcp/final-cut-live.md"), "utf8");
  const liveE2e = await readFile(join(repositoryRoot, "docs/tests/final-cut-live-e2e.md"), "utf8");
  const roughCutConstruction = await readFile(join(repositoryRoot, "docs/architecture/rough-cut-construction.md"), "utf8");

  assert.match(compatibility, /## Editing surface semantics/);
  assert.match(compatibility, /Target[\s\S]*Revision[\s\S]*Read-after-write[\s\S]*Undo[\s\S]*Resulting project state/);
  for (const surface of ["artifact.edit", "artifact.publish", "editor.timeline.edit"]) {
    const escapedSurface = surface.replaceAll(".", "\\.");
    assert.match(compatibility, new RegExp("\\| `" + escapedSurface + "` \\|"));
    assert.match(backendSelection, new RegExp("\\b" + escapedSurface + "\\b"));
    assert.match(mcpTools, new RegExp("\\| `" + escapedSurface + "`"));
  }
  assert.match(mcpTools, /artifact\.publish[\s\S]*artifactPath[\s\S]*confirm/);
  assert.match(mcpTools, /PUBLISH_CONFIRMATION_REQUIRED/);
  assert.match(finalCutInstallation, /FRAMEKIT_FINAL_CUT_CANONICAL_REQUIRED/);
  assert.match(finalCutInstallation, /FRAMEKIT_FINAL_CUT_CANONICAL_PROVIDER=native/);
  assert.match(finalCutInstallation, /File > Export XML/);
  assert.match(finalCutInstallation, /native Undo/);
  assert.match(finalCutInstallation, /FINAL_CUT_CANONICAL_FALLBACK_CONFLICT/);
  assert.match(finalCutLive, /canonical-write/);
  assert.match(finalCutLive, /FRAMEKIT_FINAL_CUT_CANONICAL_PROVIDER=native/);
  assert.match(finalCutLive, /Export XML/);
  assert.match(finalCutLive, /editor\.timeline\.edit\.preview/);
  assert.match(finalCutLive, /one `rename-clip` transaction/);
  assert.match(finalCutLive, /metadata-only/);
  assert.doesNotMatch(mcpTools, /\| `timeline\.edit` \|/);
  assert.doesNotMatch(mcpTools, /\| `timeline\.publish\.new-project` \|/);
  assert.match(liveE2e, /FCPXML publisher headed E2E/);
  assert.match(liveE2e, /FRAMEKIT_FINAL_CUT_E2E_FCPXML_PATH/);
  assert.match(liveE2e, /test:final-cut-publisher-headed/);
  assert.match(liveE2e, /prepared disposable fixture[\s\S]*project/);
  assert.match(roughCutConstruction, /Final Cut makes the imported\s+project active/);
  assert.match(roughCutConstruction, /It never modifies the previously\s+open project/);
});
