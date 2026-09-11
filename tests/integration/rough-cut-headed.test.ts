import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("rough-cut headed acceptance is wired as an opt-in MCP runner", async () => {
  const [packageJson, runner, documentation] = await Promise.all([
    readFile("package.json", "utf8").then((value) => JSON.parse(value) as { scripts?: Record<string, string> }),
    readFile("scripts/final-cut-rough-cut-headed-e2e.mjs", "utf8"),
    readFile("docs/tests/final-cut-live-e2e.md", "utf8"),
  ]);

  assert.equal(packageJson.scripts?.["test:final-cut-rough-cut-headed"], "node scripts/final-cut-rough-cut-headed-e2e.mjs");
  for (const tool of [
    "connection.status",
    "editor.inspect",
    "editor.native.inspect",
    "editor.live.inspect",
    "editor.native.media.import",
    "editor.native.media.search",
    "editor.native.media.select",
    "editor.native.media.append.preview",
    "editor.native.media.append.execute",
    "editor.native.media.insert.preview",
    "editor.native.media.insert.execute",
    "editor.native.timeline.locate",
    "editor.assets",
    "editor.native.title.add.preview",
    "editor.native.title.add.execute",
    "editor.native.undo",
  ]) assert.match(runner, new RegExp(tool.replaceAll(".", "\\.")));
  assert.match(runner, /sanitizeRoughCutEvidence/);
  assert.match(runner, /FRAMEKIT_FINAL_CUT_E2E_MEDIA_PATH/);
  assert.match(runner, /FRAMEKIT_FINAL_CUT_E2E_MEDIA_DIRECTORY/);
  assert.match(runner, /status: "unrun"/);
  assert.match(runner, /"unavailable"/);
  assert.match(runner, /"failed"/);
  assert.ok(runner.indexOf("editor.native.media.append.preview") < runner.indexOf("editor.native.media.append.execute"));
  assert.ok(runner.indexOf("editor.native.title.add.preview") < runner.indexOf("editor.native.title.add.execute"));
  assert.ok(runner.indexOf('runStep("media.resolve"') < runner.indexOf("disposableUndoPreflight(liveBefore)"));
  assert.match(runner, /insert insertion time did not match the pre-placement playhead/);
  assert.match(runner, /inserted occurrence start did not match the pre-placement playhead/);
  assert.ok(runner.indexOf("process.exit(0)") < runner.indexOf("const titleDuration = parseRational"));
  assert.doesNotMatch(runner, /readdir|execFile|osascript|FCPXML|timeline\.export/);
  assert.match(documentation, /test:final-cut-rough-cut-headed/);
  assert.match(documentation, /headed-native-rough-cut-acceptance/);
  assert.match(documentation, /unavailable|unrun/i);
});
