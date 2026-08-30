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
  assert.doesNotMatch(mcpTools, /\| `timeline\.edit` \|/);
  assert.doesNotMatch(mcpTools, /\| `timeline\.publish\.new-project` \|/);
});
