import { fileURLToPath } from "node:url";
import {
  readGitConfig,
  repositoryConfigPaths,
} from "./git-config.mjs";

export { repositoryConfigPaths };

export function inspectRepositoryConfig(cwd = process.cwd()) {
  const paths = repositoryConfigPaths(cwd);
  const commonBare = readGitConfig(paths.commonConfig, "core.bare", { boolean: true });
  const worktreeBare = readGitConfig(paths.worktreeConfig, "core.bare", { boolean: true });
  const commonHooksPath = readGitConfig(paths.commonConfig, "core.hooksPath");
  const worktreeHooksPath = readGitConfig(paths.worktreeConfig, "core.hooksPath");
  return {
    ...paths,
    worktreeConfigEnabled: readGitConfig(paths.commonConfig, "extensions.worktreeConfig", { boolean: true }),
    commonBare,
    worktreeBare,
    effectiveBare: worktreeBare ?? commonBare ?? "false",
    commonHooksPath,
    worktreeHooksPath,
    effectiveHooksPath: worktreeHooksPath ?? commonHooksPath,
  };
}

export function assertRepositoryConfig(cwd = process.cwd()) {
  const state = inspectRepositoryConfig(cwd);
  const problems = [];
  if (state.worktreeConfigEnabled !== "true") {
    problems.push("extensions.worktreeConfig is not enabled");
  }
  if (state.commonBare === "true") {
    problems.push(`shared core.bare=true in ${state.commonConfig}`);
  }
  if (state.commonHooksPath && state.commonHooksPath !== ".githooks") {
    problems.push(`shared core.hooksPath=${state.commonHooksPath} in ${state.commonConfig}`);
  }
  if (state.effectiveBare !== "false") {
    problems.push(`current worktree core.bare=${state.effectiveBare}`);
  }
  if (state.effectiveHooksPath !== ".githooks") {
    problems.push(`current worktree core.hooksPath=${state.effectiveHooksPath ?? "unset"}`);
  }
  if (problems.length === 0) return state;

  throw new Error([
    "Framekit Git configuration is unsafe:",
    ...problems.map((problem) => `- ${problem}`),
    "Run `pnpm run hooks:install` to restore isolated worktree configuration.",
    `If Git worktree commands fail, repair ${state.commonConfig} explicitly:`,
    `git config --file ${state.commonConfig} core.bare false`,
    `git config --file ${state.commonConfig} core.hooksPath .githooks`,
    `git config --file ${state.worktreeConfig} core.bare false`,
    `git config --file ${state.worktreeConfig} core.hooksPath .githooks`,
  ].join("\n"));
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    assertRepositoryConfig();
    process.stdout.write("Framekit Git configuration is healthy.\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
