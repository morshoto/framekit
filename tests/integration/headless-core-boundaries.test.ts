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

function collectRuntimeDependencies(source: string): string[] {
  const dependencies: string[] = [];

  for (const match of source.matchAll(/^\s*import\s+([\s\S]*?)(?:\s+from\s+)?["']([^"']+)["'];?/gm)) {
    if (hasRuntimeSpecifiers(match[1] ?? "")) dependencies.push(match[2]!);
  }
  for (const match of source.matchAll(/^\s*export\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];?/gm)) {
    if (hasRuntimeSpecifiers(match[1] ?? "")) dependencies.push(match[2]!);
  }

  return dependencies;
}

function hasRuntimeSpecifiers(clause: string): boolean {
  const normalized = clause.trim();
  if (!normalized || /^type\b/.test(normalized)) return !normalized;
  const named = normalized.match(/\{([\s\S]*)\}/)?.[1];
  if (named !== undefined) return named.split(",").some((specifier) => !/^\s*type\b/.test(specifier.trim()));
  return true;
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
    const dependencies = collectRuntimeDependencies(source);
    assert.doesNotMatch(dependencies.join("\n"), /@modelcontextprotocol|apps\/mcp-server|adapters\/final-cut|final-cut|FinalCut|FCPXML/i);
  }
});

test("runtime dependency scan includes side-effect imports and value re-exports", () => {
  const dependencies = collectRuntimeDependencies(`
    import "adapters/final-cut";
    import { type TimelineIr } from "@framekit/runtime";
    export * from "@modelcontextprotocol/sdk";
    export { type TimelineIr } from "@framekit/runtime";
    export { runtimeValue } from "adapters/final-cut";
  `);

  assert.deepEqual(dependencies, ["adapters/final-cut", "@modelcontextprotocol/sdk", "adapters/final-cut"]);
});
