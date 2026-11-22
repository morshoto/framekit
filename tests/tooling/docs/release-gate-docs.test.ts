import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("release gate documentation records commands and evidence boundaries", async () => {
  const documentation = await readFile("docs/testing.md", "utf8");

  assert.match(documentation, /pnpm run test:release-gate/);
  assert.match(documentation, /pnpm run release-gate --output-dir/);
  assert.match(documentation, /--headed-evidence-dir/);
  assert.match(documentation, /pnpm install --frozen-lockfile/);
  assert.match(documentation, /check:boundaries/);
  assert.match(documentation, /mcp evaluation/i);
  for (const tier of ["deterministic", "FCPXML artifact", "metadata-only", "canonical-live", "headed-native"]) {
    assert.match(documentation, new RegExp(tier, "i"));
  }
  assert.match(documentation, /unrun/i);
  assert.match(documentation, /provenance/i);
  assert.match(documentation, /deterministic/i);
  assert.match(documentation, /FCPXML/);
  assert.match(documentation, /live Final Cut/i);
  assert.match(documentation, /unsupported/i);
  for (const scenario of ["obvious", "protected", "multi-filler", "quiet", "silent", "peak-risk", "gain-clamp"]) {
    assert.match(documentation, new RegExp(scenario));
  }
});

test("release gate documentation lists every required headed-native runner", async () => {
  const documentation = await readFile("docs/testing.md", "utf8");

  for (const command of [
    "test:final-cut-canonical-headed",
    "test:final-cut-pip-headed",
    "test:final-cut-title-headed",
    "test:final-cut-masking-headed",
    "test:final-cut-filler-headed",
    "test:final-cut-dialogue-headed",
  ]) {
    assert.match(documentation, new RegExp(command.replaceAll(".", "\\.")));
  }
  assert.match(documentation, /headed-native=verified/);
  assert.match(documentation, /mkdir -p artifacts\/final-cut-headed/);
  assert.match(documentation, /sanitized/i);
  assert.match(documentation, /disposable project/i);
  assert.match(documentation, /dialogue normalization.*complete declared Skill\s+capability/is);
});

test("architecture documentation describes the generic MCP Skill lifecycle", async () => {
  const documentation = await readFile("docs/architecture.md", "utf8");

  for (const tool of ["skill.list", "skill.inspect", "skill.preview", "skill.execute"]) {
    assert.match(documentation, new RegExp("`" + tool.replaceAll(".", "\\.") + "`"));
  }
  assert.match(documentation, /exact preview target and revision/);
  assert.match(documentation, /verification and rollback status/);
});

test("architecture and release docs state evidence and release provenance boundaries", async () => {
  const architecture = await readFile("docs/architecture.md", "utf8");
  const testing = await readFile("docs/testing.md", "utf8");
  const release = await readFile("docs/release.md", "utf8");
  const readme = await readFile("docs/README.md", "utf8");

  assert.match(architecture, /metadata-only/i);
  assert.match(testing, /v0\.1\.6/);
  assert.match(release, /release gate/i);
  assert.match(release, /pnpm run release-gate --output-dir/);
  assert.match(release, /checksum/i);
  assert.match(readme, /\[Release\]\(\.\/release\.md\)/);
});
