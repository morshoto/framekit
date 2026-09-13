import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const investigationPath = join(repositoryRoot, "docs/final-cut/native-write-undo-investigation.md");

async function readInvestigation(): Promise<string> {
  return readFile(investigationPath, "utf8");
}

test("native write investigation records the current evidence boundary", async () => {
  const documentation = await readInvestigation();

  assert.match(documentation, /# Non-UI Final Cut Native Write and Undo Investigation/);
  assert.match(documentation, /Issue: \[#256\]/);
  assert.match(documentation, /Status: Decision recorded/);
  assert.match(documentation, /Final Cut Pro 10\.7\.1/);
  assert.match(documentation, /No supported non-UI native timeline write or native Undo API/);
  assert.match(documentation, /read-only/);
});

test("native write investigation covers every requested operation and provider", async () => {
  const documentation = await readInvestigation();
  const operations = [
    "media import and append",
    "trim and timeline placement",
    "title placement",
    "picture-in-picture and transform properties",
    "mask properties",
    "native Undo and transaction restoration",
  ];

  for (const operation of operations) {
    const row = documentation
      .split("\n")
      .find((line) => line.startsWith(`| \`${operation}\` |`));
    assert.ok(row, `missing decision row for ${operation}`);
    assert.match(row, /\*\*(background-capable|headed-only|unavailable)\*\*/);
  }

  for (const provider of ["ProExtensionHost", "Current Final Cut Apple Events", "Workflow Extension host APIs", "Documented FCPXML interchange"]) {
    assert.match(documentation, new RegExp(provider));
  }
});

test("native write investigation defines the minimum safe executor contract", async () => {
  const documentation = await readInvestigation();

  for (const requirement of [
    "target identity",
    "base revision",
    "preview diff",
    "atomic mutation",
    "post-write readback",
    "failure handling",
    "reversible restoration",
  ]) {
    assert.match(documentation, new RegExp(requirement, "i"));
  }

  assert.match(documentation, /target-bound/);
  assert.match(documentation, /rollback/);
  assert.match(documentation, /CAPABILITY_UNAVAILABLE/);
});

test("native write investigation preserves non-UI and unsupported-operation safety boundaries", async () => {
  const documentation = await readInvestigation();

  assert.match(documentation, /ProEditor\.sdef/);
  assert.match(documentation, /ProExtensionHost\.framework/);
  assert.match(documentation, /nm -gU/);
  assert.match(documentation, /sdef/);
  assert.match(documentation, /frontmost/);
  assert.match(documentation, /focus/);
  assert.match(documentation, /select/);
  assert.match(documentation, /background-capable/);
  assert.match(documentation, /undocumented `?\.fcpbundle`?/i);
  assert.match(documentation, /must not.*SQLite|SQLite.*must not/i);
});
