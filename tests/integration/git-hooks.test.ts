import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { access, constants, stat } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { basename, dirname, resolve } from "node:path";
import { hasNativeChanges, isNativePath } from "../../scripts/staged-native-changes.mjs";
import { installHooks } from "../../scripts/install-git-hooks.mjs";
import { finalCutMcpEnvironment } from "./final-cut-test-env.js";

const exec = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cleanGitEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);

function git(directory: string, args: string[]) {
  return exec("git", args, { cwd: directory, env: cleanGitEnvironment });
}

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
  await git(directory, ["init", "--quiet"]);

  const first = installHooks(directory);
  const second = installHooks(directory);
  assert.equal(first.hooksPath, ".githooks");
  assert.equal(second.hookPath, hookPath);
  assert.equal((await git(directory, ["config", "--get", "core.hooksPath"])).stdout.trim(), ".githooks");
  await access(hookPath, constants.X_OK);
  assert.notEqual((await stat(hookPath)).mode & 0o111, 0);
});

test("hook installer isolates Git config for linked worktrees", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-worktree-config-"));
  await mkdir(join(directory, ".githooks"), { recursive: true });
  const hookPath = join(directory, ".githooks", "pre-commit");
  await writeFile(hookPath, "#!/bin/sh\nexit 0\n");
  await chmod(hookPath, 0o755);
  await git(directory, ["init", "--quiet"]);
  await git(directory, ["config", "user.email", "test@example.com"]);
  await git(directory, ["config", "user.name", "Framekit Test"]);
  await writeFile(join(directory, "README.md"), "test\n");
  await git(directory, ["add", "README.md"]);
  await git(directory, ["commit", "--quiet", "-m", "init"]);

  installHooks(directory);

  assert.equal(
    (await git(directory, ["config", "--get", "extensions.worktreeConfig"])).stdout.trim(),
    "true",
  );
  assert.equal(
    (await git(directory, ["config", "--worktree", "--get", "core.bare"])).stdout.trim(),
    "false",
  );
  assert.equal(
    (await git(directory, ["config", "--worktree", "--get", "core.hooksPath"])).stdout.trim(),
    ".githooks",
  );

  const linkedWorktree = `${directory}-linked`;
  const linkedBranch = `linked-${basename(directory)}`;
  await git(directory, ["worktree", "add", "--quiet", linkedWorktree, "-b", linkedBranch]);
  try {
    await git(linkedWorktree, ["config", "--worktree", "core.bare", "true"]);
    assert.equal(
      (await git(directory, ["rev-parse", "--is-bare-repository"])).stdout.trim(),
      "false",
    );
  } finally {
    await git(directory, ["worktree", "remove", "--force", linkedWorktree]);
  }
});

test("pre-commit hook is executable and shell-valid", async () => {
  const hookPath = join(repository, ".githooks", "pre-commit");
  await access(hookPath, constants.X_OK);
  assert.notEqual((await stat(hookPath)).mode & 0o111, 0);
  await exec("bash", ["-n", hookPath]);
});

test("pre-commit hook presents grouped validation stages and failure diagnostics", async () => {
  const hook = await readFile(join(repository, ".githooks", "pre-commit"), "utf8");
  assert.match(hook, /run_step\(\)/);
  assert.match(hook, /#%d \[%d\/%d\]/);
  assert.match(hook, /run_step "git configuration" node scripts\/check-git-config\.mjs/);
  assert.match(hook, /run_step "sanitize staged content" node scripts\/check-staged-content\.mjs/);
  assert.match(hook, /--test-reporter=dot/);
  assert.match(hook, /mktemp -d/);
  assert.match(hook, /cat \"\$log_file\" >&2/);
  assert.doesNotMatch(hook, /corepack pnpm/);
});

test("Git configuration guard is available as a developer command", async () => {
  const manifest = JSON.parse(await readFile(join(repository, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.equal(manifest.scripts?.["check:git-config"], "node scripts/check-git-config.mjs");
});

test("pre-commit hook animates only in color-capable terminals", async () => {
  const hook = await readFile(join(repository, ".githooks", "pre-commit"), "utf8");
  assert.match(hook, /-t 1 && -t 2/);
  assert.match(hook, /NO_COLOR/);
  assert.match(hook, /spinner_frames=/);
  assert.match(hook, /kill -0/);
  assert.match(hook, /sleep 0\.08/);
  assert.match(hook, /\\r\\033\[2K/);
});

test("pinned pnpm self-management is already recorded in the lockfile", async () => {
  const manifest = JSON.parse(await readFile(join(repository, "package.json"), "utf8")) as { packageManager?: string };
  const version = manifest.packageManager?.replace(/^pnpm@/, "");
  assert.ok(version);
  const lockfile = await readFile(join(repository, "pnpm-lock.yaml"), "utf8");
  const escapedVersion = version.replaceAll(".", "\\.");
  assert.match(lockfile, new RegExp(`(?:^|\\n)\\s+pnpm:\\n\\s+specifier: ${escapedVersion}\\n\\s+version: ${escapedVersion}`));
  assert.match(lockfile, new RegExp(`(?:^|\\n)\\s+pnpm@${escapedVersion}:`));
  assert.match(lockfile, new RegExp(`[\'\"]@pnpm/exe(?:\\.[^\'\"]+)?@${escapedVersion}[\'\"]`));
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
