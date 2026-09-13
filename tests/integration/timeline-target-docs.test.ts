import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repository = process.cwd();

test("stable timeline target documentation defines the shared safety contract", async () => {
  const decision = await readFile(join(repository, "docs/adr/0010-stable-timeline-targets.md"), "utf8");

  for (const term of [
    "TimelineTarget",
    "projectId",
    "sequenceId",
    "revision",
    "mediaId",
    "occurrence",
    "frameDuration",
    "read-after-write",
    "fail closed",
  ]) {
    assert.match(decision, new RegExp(term.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")), term);
  }
});

test("MCP and Final Cut docs expose stable target compatibility", async () => {
  const [tools, readme] = await Promise.all([
    readFile(join(repository, "docs/mcp/tools.md"), "utf8"),
    readFile(join(repository, "docs/final-cut/README.md"), "utf8"),
  ]);

  assert.match(tools, /editor\.native\.media\.target/);
  assert.match(tools, /stable [`\\`]TimelineTarget/);
  assert.match(tools, /projectId, sequenceId, revision, and occurrence/);
  assert.match(tools, /selection\/playhead compatibility/);
  assert.match(readme, /0010-stable-timeline-targets/);
});
