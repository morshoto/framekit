export interface InstalledCodexPluginIdentity {
  version: string;
  identitySource:
    | "installed-content-equals-clean-source"
    | "installed-content-equals-dirty-source"
    | "installed-content-differs-from-source";
  contentDigest: string;
  sourceContentDigest: string;
  commit?: string;
  sourceCommit?: string;
}

export function inspectInstalledCodexPlugin(input: {
  installedPath: string;
  sourcePath: string;
  codexHome: string;
  version: string;
  sourceCommit: string;
  sourceClean: boolean;
}): Promise<InstalledCodexPluginIdentity>;
export function digestCodexPluginDirectory(directory: string): Promise<string>;
export function isInstalledCodexPluginBoundToCandidate(
  plugin: unknown,
  expectedSourceDigest: string,
  expectedCommit: string,
): boolean;
export function isCodexPluginIdentitySource(value: unknown): value is InstalledCodexPluginIdentity["identitySource"];
