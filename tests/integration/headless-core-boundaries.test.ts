import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const contractPath = join(repositoryRoot, "docs/architecture/headless-core-ssot.md");
const domainPath = join(repositoryRoot, "packages/runtime/src/domain");

async function readContract(): Promise<string> {
  return readFile(contractPath, "utf8");
}

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectTypeScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

test("headless SSoT contract documents the canonical flow and ownership boundaries", async () => {
  const contract = await readContract();

  assert.match(contract, /# Headless Core and Source of Truth/);
  for (const term of [
    "Framekit Project",
    "Timeline IR",
    "atomic persisted state",
    "revision-guarded",
    "headless renderer",
    "verified video",
    "NLE synchronization adapter",
  ]) {
    assert.match(contract, new RegExp(term));
  }
  assert.match(contract, /Final Cut Pro is closed/);
  assert.match(contract, /Final Cut Pro is not installed/);
  assert.match(contract, /never silently fall back/i);
});

test("headless SSoT contract separates project revision from history commits", async () => {
  const contract = await readContract();

  assert.match(contract, /project revision/);
  assert.match(contract, /concurrency|stale-write/i);
  assert.match(contract, /history commit/);
  assert.match(contract, /deferred/i);
  assert.match(contract, /Git-like commits[\s\S]*deferred[\s\S]*must not be inferred/i);
});

test("canonical runtime domain has no transport or NLE adapter dependency", async () => {
  const files = await collectTypeScriptFiles(domainPath);
  assert.ok(files.length > 0);

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const imports = source.match(/^import[\s\S]*?from\s+["'][^"']+["'];?$/gm) ?? [];
    assert.doesNotMatch(imports.join("\n"), /@modelcontextprotocol|apps\/mcp-server|adapters\/final-cut|final-cut|FinalCut|FCPXML/i);
  }
});
