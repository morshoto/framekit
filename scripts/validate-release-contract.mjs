import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const expectedRepository = "morshoto/framekit";
const expectedRepositoryUrl = `https://github.com/${expectedRepository}.git`;

export function validateReleaseContract({ packageManifest, releaseTag, githubRepository }) {
  const failures = [];
  const expectedVersion = typeof releaseTag === "string" && releaseTag.startsWith("v")
    ? releaseTag.slice(1)
    : "";

  if (!expectedVersion || packageManifest?.version !== expectedVersion) {
    failures.push(`package version "${packageManifest?.version ?? ""}" does not match release tag "${releaseTag ?? ""}"`);
  }
  if (githubRepository !== expectedRepository || packageManifest?.repository?.url !== expectedRepositoryUrl) {
    failures.push(`repository "${packageManifest?.repository?.url ?? ""}" does not match "${expectedRepositoryUrl}"`);
  }
  if (packageManifest?.private !== false || packageManifest?.publishConfig?.access !== "public") {
    failures.push("package must be public");
  }
  if (failures.length > 0) {
    throw new Error(`RELEASE_CONTRACT_INVALID: ${failures.join("; ")}`);
  }
}

async function validateCheckedOutPackage() {
  const packageManifest = JSON.parse(await readFile(resolve(process.cwd(), "package.json"), "utf8"));
  validateReleaseContract({
    packageManifest,
    releaseTag: process.env.RELEASE_TAG,
    githubRepository: process.env.GITHUB_REPOSITORY,
  });
  process.stdout.write(`Release contract valid for ${packageManifest.name}@${packageManifest.version}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  validateCheckedOutPackage().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
