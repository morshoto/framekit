import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function readRepositoryFile(relativePath: string): Promise<string> {
  return readFile(resolve(repository, relativePath), "utf8");
}

test("CodeQL keeps default-branch runs from being cancelled", async () => {
  const workflow = await readRepositoryFile(".github/workflows/codeql.yml");

  assert.match(workflow, /push:\s+branches:\s+- main/);
  assert.match(workflow, /group:\s+codeql-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}/);
  assert.match(workflow, /cancel-in-progress:\s+\$\{\{ github\.event_name == 'pull_request' \}\}/);
});

test("CodeQL still supersedes obsolete pull-request runs", async () => {
  const workflow = await readRepositoryFile(".github/workflows/codeql.yml");

  assert.match(workflow, /pull_request:\s+branches:\s+- main/);
  assert.match(workflow, /types:\s+- opened\s+- synchronize\s+- reopened/);
  assert.match(workflow, /github\.event_name == 'pull_request'/);
});

test("CodeQL concurrency policy is documented for operators", async () => {
  const documentation = await readRepositoryFile("docs/ci/codeql.md");

  assert.match(documentation, /default-branch.*queue/i);
  assert.match(documentation, /pull-request.*cancel/i);
  assert.match(documentation, /one.*running.*one.*pending/i);
  assert.match(documentation, /code-scanning analyses API/i);
});

test("CodeQL verification documentation records operational metadata", async () => {
  const documentation = await readRepositoryFile("docs/ci/codeql.md");

  for (const expected of [
    /^Status:\s+.+$/im,
    /^Last verified:\s+\d{4}-\d{2}-\d{2}/im,
    /^Environment:\s+.+$/im,
    /^Scope:\s+.+$/im,
    /^Expected result:\s+.+$/im,
    /^Actual evidence:\s+.+$/im,
    /^Limitations:\s+.+$/im,
  ]) {
    assert.match(documentation, expected);
  }
});

test("CodeQL preserves JavaScript analysis and adds a bounded Swift job", async () => {
  const workflow = await readRepositoryFile(".github/workflows/codeql.yml");

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
    /\n      - name: Build Swift sources for CodeQL extraction\n        timeout-minutes: 5\n        run: \|/,
  );
});

test("Swift CodeQL extraction uses the checked-in shim only", async () => {
  const workflow = await readRepositoryFile(".github/workflows/codeql.yml");

  assert.match(workflow, /xcodebuild/);
  assert.match(workflow, /-scheme FramekitFinalCutWorkflowExtension/);
  assert.match(workflow, /-D FRAMEKIT_CODEQL/);
  assert.match(workflow, /SWIFT_ACTIVE_COMPILATION_CONDITIONS=FRAMEKIT_CODEQL/);
  assert.match(workflow, /SWIFT_USE_INTEGRATED_DRIVER=NO/);
  assert.match(workflow, /COMPILATION_CACHE_ENABLE_CACHING=NO/);
  assert.match(workflow, /SWIFT_ENABLE_COMPILE_CACHE=NO/);
  assert.match(workflow, /FRAMEWORK_SEARCH_PATHS=/);
  assert.match(workflow, /LD_RUNPATH_SEARCH_PATHS=/);
  assert.match(workflow, /OTHER_LDFLAGS=/);
  assert.match(workflow, /FinalCutLiveWorkflowExtension\.swift/);
  assert.match(workflow, /\.github\/codeql\/FinalCutWorkflowExtensionShim\.swift/);
  assert.doesNotMatch(workflow, /xcrun swiftc/);
  assert.doesNotMatch(workflow, /-emit-module/);
  assert.doesNotMatch(workflow, /ProExtensionHostShim/);
  assert.doesNotMatch(workflow, /Final Cut Pro\.app/);
  assert.doesNotMatch(workflow, /ProExtensionHost\.framework/);
  assert.doesNotMatch(workflow, /FRAMEWORK_SEARCH_PATHS/);
  assert.doesNotMatch(workflow, /build\.sh/);
});

test("CodeQL substitutes host declarations without changing the native import", async () => {
  const source = await readRepositoryFile("adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/FinalCutLiveWorkflowExtension.swift");
  const shim = await readRepositoryFile(".github/codeql/FinalCutWorkflowExtensionShim.swift");
  const project = await readRepositoryFile("adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/FramekitFinalCutWorkflow.xcodeproj/project.pbxproj");

  assert.match(source, /#if !FRAMEKIT_CODEQL[\s\S]*import ProExtensionHost[\s\S]*#endif/);
  assert.match(shim, /import CoreMedia/);
  assert.match(shim, /protocol FCPXTimelineObserver/);
  assert.match(shim, /func ProExtensionHostSingleton/);
  assert.match(project, /FinalCutWorkflowExtensionShim\.swift/);
});

test("Swift CI remains an independent native validation gate", async () => {
  const workflow = await readRepositoryFile(".github/workflows/swift.yml");

  assert.match(workflow, /name: Swift CI/);
  assert.match(workflow, /xcodebuild[\s\S]*-list/);
  assert.match(workflow, /xcrun swiftc/);
  assert.match(workflow, /ProExtensionHostShim/);
});

test("Swift bridge documents the separate bounded CodeQL path", async () => {
  const documentation = await readRepositoryFile("adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/README.md");

  assert.match(documentation, /CodeQL Swift extraction/);
  assert.match(documentation, /manual\s+`xcodebuild`/);
  assert.match(documentation, /checked-in\s+`.github\/codeql\/FinalCutWorkflowExtensionShim\.swift`/);
  assert.match(documentation, /integrated Swift driver/);
  assert.match(documentation, /does not\s+invoke[\s\S]*`build\.sh`/);
  assert.match(documentation, /five minutes/);
  assert.match(documentation, /standalone Swift CI/);
});
