import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const contractPath = resolve("docs/final-cut/basic-editing-mvp.md");

test("Basic Final Cut editing MVP has an executable design contract", async () => {
  const contract = await readFile(contractPath, "utf8");

  assert.match(contract, /^# Basic Final Cut Editing MVP/m);
  for (const stage of [
    "Understand the active project",
    "Import local media",
    "Make a basic edit",
    "Add music and a title",
    "Export the result",
    "Verify the output",
  ]) {
    assert.match(contract, new RegExp(`## .*${stage}`));
  }

  for (const tool of [
    "connection.status",
    "editor.inspect",
    "project.inspect",
    "media.import",
    "media.inspect",
    "timeline.edit",
    "timeline.media.add",
    "timeline.title.add",
    "editor.assets",
    "timeline.export",
    "edit.verify",
    "edit.undo",
  ]) {
    assert.match(contract, new RegExp("`" + tool + "`"));
  }

  assert.match(contract, /preview/);
  assert.match(contract, /execute/);
  assert.match(contract, /base revision/i);
  assert.match(contract, /CAPABILITY_UNAVAILABLE/);
  assert.match(contract, /deterministic fixture/i);
  assert.match(contract, /live Final Cut/i);
  assert.match(contract, /success metrics/i);
  assert.match(contract, /100%/);
  assert.match(contract, /rollback/i);
});
