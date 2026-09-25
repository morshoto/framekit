import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("background editable handoff architecture preserves layered safety boundaries", async () => {
  const document = await readFile("docs/architecture/background-editable-handoff.md", "utf8");

  for (const term of [
    "provider-neutral Timeline IR",
    "EditingSession",
    "versioned editable project",
    "original project",
    "canonical resync",
    "headed-native fallback",
    "foreground activation",
    "FCPXML",
  ]) {
    assert.match(document, new RegExp(term.replaceAll(".", "\\."), "i"), `${term} should be documented`);
  }
  assert.match(document, /must not.*flatten/i);
  assert.match(document, /fail closed/i);
  assert.match(document, /canonical.*readback/i);
});
