export function repositoryRoot(cwd?: string): string;
export function installHooks(repoRoot?: string): {
  repoRoot: string;
  hooksPath: string;
  hookPath: string;
};
