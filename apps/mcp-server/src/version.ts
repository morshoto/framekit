import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FRAMEKIT_PACKAGE_NAME = "@morshoto/framekit";

interface PackageManifest {
  name?: unknown;
  version?: unknown;
}

export const FRAMEKIT_VERSION = readFramekitVersion();

export interface FramekitBuildFingerprint {
  version: string;
  commit: string;
}

export const FRAMEKIT_BUILD_FINGERPRINT: FramekitBuildFingerprint = Object.freeze({
  version: FRAMEKIT_VERSION,
  commit: readFramekitCommit(),
});

function readFramekitVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.url));

  while (true) {
    const manifestPath = join(directory, "package.json");
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
      if (manifest.name === FRAMEKIT_PACKAGE_NAME) {
        if (typeof manifest.version !== "string" || manifest.version.length === 0) {
          throw new Error(`FRAMEKIT_PACKAGE_VERSION_INVALID: ${manifestPath}`);
        }
        return manifest.version;
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }

    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  throw new Error(`FRAMEKIT_PACKAGE_VERSION_UNAVAILABLE: ${FRAMEKIT_PACKAGE_NAME}`);
}

function isMissingFile(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "ENOENT";
}

function readFramekitCommit(): string {
  const configured = process.env.FRAMEKIT_BUILD_COMMIT?.trim();
  if (configured) return configured;

  const repositoryRoot = findRepositoryRoot(dirname(fileURLToPath(import.meta.url)));
  if (!repositoryRoot) return "unknown";

  try {
    const gitEntry = join(repositoryRoot, ".git");
    const gitDirectory = readGitDirectory(gitEntry);
    const head = readFileSync(join(gitDirectory, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{7,64}$/i.test(head)) return head;
    if (!head.startsWith("ref: ")) return "unknown";
    const ref = head.slice("ref: ".length).trim();
    if (!ref) return "unknown";
    const commonDirectory = readCommonDirectory(gitDirectory);
    const refCandidates = [join(gitDirectory, ref)];
    if (commonDirectory) refCandidates.push(join(commonDirectory, ref));
    for (const refPath of refCandidates) {
      try {
        const commit = readFileSync(refPath, "utf8").trim();
        if (/^[0-9a-f]{7,64}$/i.test(commit)) return commit;
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    }
    if (commonDirectory) {
      const packedRefs = readFileSync(join(commonDirectory, "packed-refs"), "utf8");
      const packedRef = packedRefs
        .split("\n")
        .map((line) => line.trim().split(" "))
        .find(([commit, name]) => name === ref && /^[0-9a-f]{7,64}$/i.test(commit ?? ""));
      if (packedRef?.[0]) return packedRef[0];
    }
  } catch (error) {
    if (!isMissingFile(error)) return "unknown";
  }
  return "unknown";
}

function findRepositoryRoot(start: string): string | undefined {
  let directory = start;
  while (true) {
    if (isGitEntry(join(directory, ".git"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function isGitEntry(path: string): boolean {
  try {
    readFileSync(path, "utf8");
    return true;
  } catch (error) {
    if (!isMissingFile(error)) return true;
    return false;
  }
}

function readGitDirectory(gitEntry: string): string {
  const content = readFileSync(gitEntry, "utf8").trim();
  if (!content.startsWith("gitdir: ")) return gitEntry;
  const configured = content.slice("gitdir: ".length).trim();
  return isAbsolute(configured) ? configured : resolve(dirname(gitEntry), configured);
}

function readCommonDirectory(gitDirectory: string): string | undefined {
  try {
    const configured = readFileSync(join(gitDirectory, "commondir"), "utf8").trim();
    if (!configured) return undefined;
    return isAbsolute(configured) ? configured : resolve(gitDirectory, configured);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    return undefined;
  }
}
