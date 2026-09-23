import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { installHooks } from "../../scripts/install-git-hooks.mjs";
import { assertRepositoryConfig, repositoryConfigPaths } from "../../scripts/check-git-config.mjs";

const exec = promisify(execFile);
const cleanGitEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);

function git(directory: string, args: string[]) {
  return exec("git", args, { cwd: directory, env: cleanGitEnvironment });
}

async function temporaryRepository() {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-git-config-"));
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
  return directory;
}

test("repository config guard accepts protected worktree configuration", async () => {
  const directory = await temporaryRepository();
  try {
    assert.doesNotThrow(() => assertRepositoryConfig(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("repository config guard rejects a shared bare-repository mutation", async () => {
  const directory = await temporaryRepository();
  try {
    const { commonConfig } = repositoryConfigPaths(directory);
    await git(directory, ["config", "--file", commonConfig, "core.bare", "true"]);

    assert.throws(
      () => assertRepositoryConfig(directory),
      (error: unknown) => error instanceof Error
        && /core\.bare=true/.test(error.message)
        && /pnpm run hooks:install/.test(error.message),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("repository config guard rejects an unexpected shared hook path", async () => {
  const directory = await temporaryRepository();
  try {
    const { commonConfig } = repositoryConfigPaths(directory);
    await git(directory, ["config", "--file", commonConfig, "core.hooksPath", "/tmp/unexpected-hooks"]);

    assert.throws(
      () => assertRepositoryConfig(directory),
      (error: unknown) => error instanceof Error && /core\.hooksPath/.test(error.message),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("repository config guard rejects an invalid current worktree hook path", async () => {
  const directory = await temporaryRepository();
  try {
    const { worktreeConfig } = repositoryConfigPaths(directory);
    await git(directory, ["config", "--file", worktreeConfig, "core.hooksPath", "/tmp/unexpected-hooks"]);

    assert.throws(
      () => assertRepositoryConfig(directory),
      (error: unknown) => error instanceof Error && /current worktree/.test(error.message),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
