import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const repository = resolve(import.meta.dirname, "../..");

async function readWorkflow(relativePath: string): Promise<string> {
  return readFile(resolve(repository, relativePath), "utf8");
}

test("CodeQL preserves JavaScript analysis and adds a bounded Swift job", async () => {
  const workflow = await readWorkflow(".github/workflows/codeql.yml");

  assert.match(workflow, /language: javascript-typescript/);
  assert.match(workflow, /build-mode: none/);
  assert.match(workflow, /os: ubuntu-latest/);
  assert.match(workflow, /analyze-swift:/);
  assert.match(workflow, /name: Analyze \(swift\)/);
  assert.match(workflow, /runs-on: macos-15/);
  assert.match(workflow, /timeout-minutes: 15/);
  assert.match(workflow, /languages: swift/);
  assert.match(workflow, /build-mode: manual/);
  assert.match(workflow, /timeout-minutes: 5/);
});

test("Swift CodeQL extraction uses the checked-in shim only", async () => {
  const workflow = await readWorkflow(".github/workflows/codeql.yml");

  assert.match(workflow, /xcrun swiftc/);
  assert.match(workflow, /-typecheck/);
  assert.match(workflow, /FinalCutLiveWorkflowExtension\.swift/);
  assert.match(workflow, /ProExtensionHostShim/);
  assert.doesNotMatch(workflow, /Final Cut Pro\.app/);
  assert.doesNotMatch(workflow, /FRAMEWORK_SEARCH_PATHS/);
  assert.doesNotMatch(workflow, /build\.sh/);
});

test("Swift CI remains an independent native validation gate", async () => {
  const workflow = await readWorkflow(".github/workflows/swift.yml");

  assert.match(workflow, /name: Swift CI/);
  assert.match(workflow, /xcodebuild[\s\S]*-list/);
  assert.match(workflow, /xcrun swiftc/);
  assert.match(workflow, /ProExtensionHostShim/);
});

test("Swift bridge documents the separate bounded CodeQL path", async () => {
  const documentation = await readWorkflow("adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/README.md");

  assert.match(documentation, /CodeQL Swift extraction/);
  assert.match(documentation, /checked-in `ProExtensionHostShim`/);
  assert.match(documentation, /does not invoke `build\.sh`/);
  assert.match(documentation, /five-minute/);
  assert.match(documentation, /standalone Swift CI/);
});
