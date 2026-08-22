import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { access, constants, stat } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { hasNativeChanges, isNativePath } from "../../scripts/staged-native-changes.mjs";
import { installHooks } from "../../scripts/install-git-hooks.mjs";
import { finalCutMcpEnvironment } from "./final-cut-test-env.js";

const exec = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("native staged-path detection covers Swift, Xcode, and toolchain files only", () => {
  assert.equal(isNativePath("adapters/final-cut/swift-bridge/FinalCutWorkflowExtension.swift"), true);
  assert.equal(isNativePath("adapters/final-cut/swift-bridge/FramekitFinalCutWorkflow.xcodeproj/project.pbxproj"), true);
  assert.equal(isNativePath("nix/xcode-version.json"), true);
  assert.equal(isNativePath("adapters/final-cut/typescript/src/native.ts"), false);
  assert.equal(isNativePath("packages/runtime/src/runtime.ts"), false);
  assert.equal(hasNativeChanges(["README.md", "apps/mcp-server/src/server.ts"]), false);
  assert.equal(hasNativeChanges(["README.md", "nix/xcode-version.json"]), true);
});

test("hook installer configures a temporary repository idempotently", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-hooks-"));
  await mkdir(join(directory, ".githooks"), { recursive: true });
  const hookPath = join(directory, ".githooks", "pre-commit");
  await writeFile(hookPath, "#!/bin/sh\nexit 0\n");
  await chmod(hookPath, 0o755);
  await exec("git", ["init", "--quiet", directory]);

  const first = installHooks(directory);
  const second = installHooks(directory);
  assert.equal(first.hooksPath, ".githooks");
  assert.equal(second.hookPath, hookPath);
  assert.equal((await exec("git", ["-C", directory, "config", "--get", "core.hooksPath"])).stdout.trim(), ".githooks");
  await access(hookPath, constants.X_OK);
  assert.notEqual((await stat(hookPath)).mode & 0o111, 0);
});

test("pre-commit hook is executable and shell-valid", async () => {
  const hookPath = join(repository, ".githooks", "pre-commit");
  await access(hookPath, constants.X_OK);
  assert.notEqual((await stat(hookPath)).mode & 0o111, 0);
  await exec("bash", ["-n", hookPath]);
});

test("pre-commit hook forces headless fixture validation", async () => {
  const hook = await readFile(join(repository, ".githooks", "pre-commit"), "utf8");
  assert.match(hook, /export FRAMEKIT_EDITOR=fixture/);
  assert.match(hook, /export FRAMEKIT_COMMIT_VALIDATION=1/);
  assert.match(hook, /export FRAMEKIT_FINAL_CUT_HEADLESS=1/);
  assert.match(hook, /export FRAMEKIT_FINAL_CUT_NATIVE_WRITES=0/);
  assert.match(hook, /export FRAMEKIT_AUTO_CONNECT=0/);

  const environment = finalCutMcpEnvironment({
    FRAMEKIT_COMMIT_VALIDATION: "1",
    FRAMEKIT_EDITOR: "fixture",
    FRAMEKIT_FINAL_CUT_HEADLESS: "0",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "1",
  });
  assert.equal(environment.FRAMEKIT_EDITOR, "final-cut-live");
  assert.equal(environment.FRAMEKIT_FINAL_CUT_HEADLESS, "1");
  assert.equal(environment.FRAMEKIT_AUTO_CONNECT, "0");
  assert.equal(environment.FRAMEKIT_FINAL_CUT_NATIVE_WRITES, "0");

  const explicitSafeEnvironment = finalCutMcpEnvironment({
    FRAMEKIT_COMMIT_VALIDATION: "0",
    FRAMEKIT_FINAL_CUT_HEADLESS: "1",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0",
  });
  assert.equal(explicitSafeEnvironment.FRAMEKIT_FINAL_CUT_HEADLESS, "1");
  assert.equal(explicitSafeEnvironment.FRAMEKIT_AUTO_CONNECT, "0");
  assert.equal(explicitSafeEnvironment.FRAMEKIT_FINAL_CUT_NATIVE_WRITES, "0");
});
