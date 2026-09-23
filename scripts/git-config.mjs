import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const cleanGitEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);

export function git(args, options = {}) {
  return execFileSync("git", args, { ...options, env: cleanGitEnvironment });
}

export function findRepositoryRoot(cwd = process.cwd()) {
  let directory = resolve(cwd);
  while (true) {
    if (existsSync(join(directory, ".git"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Framekit Git metadata was not found above ${cwd}`);
}

export function repositoryConfigPaths(cwd = process.cwd()) {
  const root = findRepositoryRoot(cwd);
  const gitEntry = join(root, ".git");
  let gitDirectory;
  if (statSync(gitEntry).isDirectory()) {
    gitDirectory = gitEntry;
  } else {
    const pointer = readFileSync(gitEntry, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    if (!pointer) throw new Error(`Framekit Git directory pointer is invalid: ${gitEntry}`);
    gitDirectory = resolve(root, pointer);
  }
  if (!existsSync(gitDirectory)) {
    throw new Error(`Framekit Git directory could not be resolved from ${gitEntry}`);
  }

  const commonGitDirectory = basename(dirname(gitDirectory)) === "worktrees"
    ? dirname(dirname(gitDirectory))
    : gitDirectory;
  return {
    root,
    commonConfig: join(commonGitDirectory, "config"),
    worktreeConfig: join(gitDirectory, "config.worktree"),
  };
}

export function readGitConfig(configPath, key, { boolean = false } = {}) {
  if (!existsSync(configPath)) return undefined;
  try {
    const args = ["config", "--file", configPath];
    if (boolean) args.push("--type=bool");
    args.push("--get", key);
    const value = git(args, { encoding: "utf8" }).trim();
    return value || undefined;
  } catch (error) {
    if (error?.status === 1) return undefined;
    throw error;
  }
}

export function writeGitConfig(configPath, key, value) {
  git(["config", "--file", configPath, key, value], { stdio: "inherit" });
}
