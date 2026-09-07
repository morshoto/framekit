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
  assert.match(workflow, /timeout-minutes: 40/);
  assert.match(workflow, /languages: swift/);
  assert.match(workflow, /build-mode: manual/);
  assert.match(workflow, /timeout-minutes: 25/);
  assert.match(
    workflow,
    /\n      - name: Type-check Swift sources for CodeQL extraction\n        timeout-minutes: 25\n        run: \|/,
  );
});

test("Swift CodeQL extraction uses the checked-in shim only", async () => {
  const workflow = await readRepositoryFile(".github/workflows/codeql.yml");
  const project = await readRepositoryFile("adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/project.yml");
  const swiftJob = workflow.match(
    /\n  analyze-swift:\n[\s\S]*?(?=\n  [a-z][a-z0-9-]*:\n|$)/,
  )?.[0];

  assert.ok(swiftJob, "Swift CodeQL job should be present");

  assert.match(swiftJob, /xcrun --sdk macosx swiftc/);
  assert.match(swiftJob, /-typecheck/);
  assert.match(swiftJob, /-parse-as-library/);
  assert.match(swiftJob, /-target \"\$\(uname -m\)-apple-macos15\.0\"/);
  assert.match(swiftJob, /-swift-version 5/);
  assert.match(swiftJob, /timeout-minutes: 40/);
  assert.match(swiftJob, /timeout-minutes: 25/);
  assert.match(swiftJob, /-D FRAMEKIT_CODEQL/);
  assert.doesNotMatch(swiftJob, /xcodebuild/);
  assert.doesNotMatch(swiftJob, /-scheme FramekitFinalCutWorkflowExtension/);
  assert.doesNotMatch(swiftJob, /-destination/);
  assert.doesNotMatch(swiftJob, /-emit-module/);
  assert.doesNotMatch(swiftJob, /ProExtensionHostShim/);
  assert.doesNotMatch(swiftJob, /Final Cut Pro\.app/);
  assert.doesNotMatch(swiftJob, /ProExtensionHost\.framework/);
  assert.doesNotMatch(swiftJob, /\/tmp\/framekit-finalcut-frameworks/);
  assert.doesNotMatch(swiftJob, /build\.sh/);
  assert.match(project, /FramekitFinalCutWorkflowCodeQL:/);
  assert.match(project, /type: library\.static/);
  assert.match(project, /FinalCutLiveWorkflowExtension\.swift/);
  assert.match(project, /\.github\/codeql\/FinalCutWorkflowExtensionShim\.swift/);
});

test("CodeQL substitutes host declarations without changing the native import", async () => {
  const source = await readRepositoryFile("adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/FinalCutLiveWorkflowExtension.swift");
  const shim = await readRepositoryFile(".github/codeql/FinalCutWorkflowExtensionShim.swift");
  const project = await readRepositoryFile("adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/FramekitFinalCutWorkflow.xcodeproj/project.pbxproj");

  assert.match(source, /#if !FRAMEKIT_CODEQL[\s\S]*import ProExtensionHost[\s\S]*#endif/);
  assert.match(source, /#if !FRAMEKIT_CODEQL[\s\S]*import AppKit[\s\S]*#endif/);
  assert.match(shim, /import CoreMedia/);
  assert.match(shim, /class NSViewController/);
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
  assert.match(documentation, /manual\s+`xcrun swiftc`/);
  assert.match(documentation, /checked-in\s+`.github\/codeql\/FinalCutWorkflowExtensionShim\.swift`/);
  assert.match(documentation, /Direct\s+compiler\s+invocation/);
  assert.match(documentation, /does not\s+invoke[\s\S]*`build\.sh`/);
  assert.match(documentation, /forty and twenty-five minutes/);
  assert.match(documentation, /standalone Swift CI/);
});
