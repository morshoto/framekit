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
  assert.match(
    workflow,
    /\n      - name: Type-check Swift sources for CodeQL extraction\n        timeout-minutes: 5\n        run: >-/,
  );
});

test("Swift CodeQL extraction uses the checked-in shim only", async () => {
  const workflow = await readWorkflow(".github/workflows/codeql.yml");

  assert.match(workflow, /xcrun swiftc/);
  assert.match(workflow, /-D FRAMEKIT_CODEQL/);
  assert.match(workflow, /run: \|/);
  assert.match(workflow, /mkdir -p "\$RUNNER_TEMP\/framekit-codeql"/);
  assert.match(workflow, /-emit-module/);
  assert.match(workflow, /-emit-module-path "\$RUNNER_TEMP\/framekit-codeql\/FramekitWorkflowExtension\.swiftmodule"/);
  assert.match(workflow, /FinalCutLiveWorkflowExtension\.swift/);
  assert.match(workflow, /\.github\/codeql\/FinalCutWorkflowExtensionShim\.swift/);
  assert.doesNotMatch(workflow, /-typecheck/);
  assert.doesNotMatch(workflow, /ProExtensionHostShim/);
  assert.doesNotMatch(workflow, /Final Cut Pro\.app/);
  assert.doesNotMatch(workflow, /ProExtensionHost\.framework/);
  assert.doesNotMatch(workflow, /FRAMEWORK_SEARCH_PATHS/);
  assert.doesNotMatch(workflow, /build\.sh/);
});

test("CodeQL substitutes host declarations without changing the native import", async () => {
  const source = await readWorkflow("adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/FinalCutLiveWorkflowExtension.swift");
  const shim = await readWorkflow(".github/codeql/FinalCutWorkflowExtensionShim.swift");

  assert.match(source, /#if !FRAMEKIT_CODEQL[\s\S]*import ProExtensionHost[\s\S]*#endif/);
  assert.match(shim, /import CoreMedia/);
  assert.match(shim, /protocol FCPXTimelineObserver/);
  assert.match(shim, /func ProExtensionHostSingleton/);
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
  assert.match(documentation, /manual\s+`xcrun swiftc -emit-module`/);
  assert.match(documentation, /checked-in\s+`.github\/codeql\/FinalCutWorkflowExtensionShim\.swift`/);
  assert.match(documentation, /does not\s+invoke[\s\S]*`build\.sh`/);
  assert.match(documentation, /five minutes/);
  assert.match(documentation, /standalone Swift CI/);
});
