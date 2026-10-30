import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const expectedRepository = "morshoto/framekit";
const expectedRepositoryUrl = `https://github.com/${expectedRepository}.git`;

export function validateReleaseContract({ packageManifest, releaseTag, githubRepository, packageBuildIdentity, candidateCommit, sourceClean }) {
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
  if (sourceClean === false) {
    failures.push("release checkout contains uncommitted changes");
  }
  if (packageBuildIdentity || candidateCommit) {
    if (packageBuildIdentity?.schemaVersion !== 1) {
      failures.push("package build identity schema is invalid");
    }
    if (!packageBuildIdentity || packageBuildIdentity.version !== packageManifest?.version) {
      failures.push("package build identity version does not match package version");
    }
    if (
      !candidateCommit
      || !/^[0-9a-f]{40}$/i.test(candidateCommit)
      || packageBuildIdentity?.commit?.toLowerCase() !== candidateCommit.toLowerCase()
    ) {
      failures.push("package build identity commit does not match the release tag commit");
    }
  }
  if (failures.length > 0) {
    throw new Error(`RELEASE_CONTRACT_INVALID: ${failures.join("; ")}`);
  }
}

async function validateCheckedOutPackage() {
  const packageManifest = JSON.parse(await readFile(resolve(process.cwd(), "package.json"), "utf8"));
  const releaseTag = process.env.RELEASE_TAG;
  if (!/^v\d+\.\d+\.\d+$/.test(releaseTag ?? "")) {
    throw new Error("RELEASE_CONTRACT_INVALID: RELEASE_TAG must be a version tag");
  }
  const packageBuildIdentity = JSON.parse(await readFile(
    resolve(process.cwd(), "dist-package/apps/mcp-server/src/build-identity.json"),
    "utf8",
  ));
  const candidateCommit = execFileSync("git", ["rev-parse", "--verify", `${releaseTag}^{commit}`], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
  const sourceClean = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim().length === 0;
  validateReleaseContract({
    packageManifest,
    releaseTag,
    githubRepository: process.env.GITHUB_REPOSITORY,
    packageBuildIdentity,
    candidateCommit,
    sourceClean,
  });
  process.stdout.write(`Release contract valid for ${packageManifest.name}@${packageManifest.version} (${candidateCommit})\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  validateCheckedOutPackage().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
