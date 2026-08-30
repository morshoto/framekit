import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function validateReleaseContract({ packageManifest, releaseTag }) {
  const expectedVersion = typeof releaseTag === "string" && releaseTag.startsWith("v")
    ? releaseTag.slice(1)
    : "";

  if (!expectedVersion || packageManifest?.version !== expectedVersion) {
    throw new Error(
      `RELEASE_CONTRACT_INVALID: package version "${packageManifest?.version ?? ""}" does not match release tag "${releaseTag ?? ""}"`,
    );
  }
}

async function validateCheckedOutPackage() {
  const packageManifest = JSON.parse(await readFile(resolve(process.cwd(), "package.json"), "utf8"));
  validateReleaseContract({
    packageManifest,
    releaseTag: process.env.RELEASE_TAG,
  });
  process.stdout.write(`Release contract valid for ${packageManifest.name}@${packageManifest.version}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  validateCheckedOutPackage().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
