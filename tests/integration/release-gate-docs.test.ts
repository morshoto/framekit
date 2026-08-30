import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("release gate documentation records commands and evidence boundaries", async () => {
  const documentation = await readFile("docs/tests/release-gate.md", "utf8");

  assert.match(documentation, /pnpm run test:release-gate/);
  assert.match(documentation, /pnpm run release-gate --output-dir/);
  assert.match(documentation, /deterministic/i);
  assert.match(documentation, /FCPXML/);
  assert.match(documentation, /live Final Cut/i);
  assert.match(documentation, /unsupported/i);
  for (const scenario of ["obvious", "protected", "multi-filler", "quiet", "silent", "peak-risk", "gain-clamp"]) {
    assert.match(documentation, new RegExp(scenario));
  }
});

test("Skill documentation describes only the generic MCP workflow", async () => {
  const documentation = await readFile("docs/mcp/skills.md", "utf8");

  for (const tool of ["skill.list", "skill.inspect", "skill.preview", "skill.execute"]) {
    assert.match(documentation, new RegExp("`" + tool.replaceAll(".", "\\.") + "`"));
  }
  assert.match(documentation, /filler-removal/);
  assert.match(documentation, /dialogue-normalization/);
  assert.match(documentation, /Final Cut-specific commands/i);
  assert.match(documentation, /preview/);
  assert.match(documentation, /rollback/);
});

test("compatibility and release documentation identify the v0.0.3 gate", async () => {
  const compatibility = await readFile("docs/COMPATIBILITY.md", "utf8");
  const release = await readFile("docs/releasing.md", "utf8");
  const readme = await readFile("docs/README.md", "utf8");

  assert.match(compatibility, /v0\.0\.3/);
  assert.match(compatibility, /fixture/i);
  assert.match(compatibility, /metadata-only/i);
  assert.match(release, /release gate/i);
  assert.match(release, /pnpm run release-gate --output-dir/);
  assert.match(readme, /release-gate/);
});
