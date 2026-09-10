import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FRAMEKIT_PACKAGE_NAME = "@morshoto/framekit";

interface PackageManifest {
  name?: unknown;
  version?: unknown;
}

export const FRAMEKIT_VERSION = readFramekitVersion();

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
