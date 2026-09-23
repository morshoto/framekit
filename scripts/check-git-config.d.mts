export type RepositoryConfigPaths = {
  root: string;
  commonConfig: string;
  worktreeConfig: string;
};

export type RepositoryConfigState = RepositoryConfigPaths & {
  worktreeConfigEnabled: string | undefined;
  commonBare: string | undefined;
  worktreeBare: string | undefined;
  effectiveBare: string;
  commonHooksPath: string | undefined;
  worktreeHooksPath: string | undefined;
  effectiveHooksPath: string | undefined;
};

export function repositoryConfigPaths(cwd?: string): RepositoryConfigPaths;
export function inspectRepositoryConfig(cwd?: string): RepositoryConfigState;
export function assertRepositoryConfig(cwd?: string): RepositoryConfigState;
