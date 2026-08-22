export const nativePathPrefixes: string[];
export function isNativePath(path: string): boolean;
export function hasNativeChanges(paths: string[]): boolean;
export function stagedPaths(cwd?: string): string[];
