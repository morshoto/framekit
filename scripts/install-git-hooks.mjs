import { accessSync, constants, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { findRepositoryRoot, repositoryConfigPaths, writeGitConfig } from "./git-config.mjs";

export function repositoryRoot(cwd = process.cwd()) {
  return findRepositoryRoot(cwd);
}

export function installHooks(repoRoot = repositoryRoot()) {
  const root = resolve(repoRoot);
  const hookPath = join(root, ".githooks", "pre-commit");
  if (!existsSync(hookPath)) throw new Error(`Framekit pre-commit hook is missing: ${hookPath}`);
  accessSync(hookPath, constants.X_OK);
  if ((statSync(hookPath).mode & 0o111) === 0) throw new Error(`Framekit pre-commit hook is not executable: ${hookPath}`);
  const { commonConfig, worktreeConfig } = repositoryConfigPaths(root);
  writeGitConfig(commonConfig, "extensions.worktreeConfig", "true");
  writeGitConfig(commonConfig, "core.bare", "false");
  writeGitConfig(worktreeConfig, "core.bare", "false");
  writeGitConfig(worktreeConfig, "core.hooksPath", ".githooks");
  writeGitConfig(commonConfig, "core.hooksPath", ".githooks");
  return { repoRoot: root, hooksPath: ".githooks", hookPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = installHooks();
  process.stdout.write(`Framekit Git hooks installed at ${result.repoRoot}/${result.hooksPath}\n`);
}
