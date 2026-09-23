import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  assessReleaseProvenance,
  type ReleaseProvenanceInput,
} from "../tests/release-gate/native-editing.js";
import { FRAMEKIT_VERSION } from "../apps/mcp-server/src/version.js";

const exec = promisify(execFile);
const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
const releaseTag = requireEnvironment("RELEASE_TAG");
const githubRepository = requireEnvironment("GITHUB_REPOSITORY");
const outputDirectory = process.env.RELEASE_PROVENANCE_OUTPUT_DIR
  ?? join(repositoryRoot, "artifacts", "release-provenance");

assertReleaseIdentity(releaseTag, githubRepository);

const packageManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as {
  name?: string;
  version?: string;
  private?: boolean;
};
const pluginManifest = JSON.parse(
  await readFile(join(repositoryRoot, "plugins/framekit/.codex-plugin/plugin.json"), "utf8"),
) as { name?: string; version?: string };
const headSha = await command("git", ["rev-parse", "HEAD"]);
const tagSha = await command("git", ["rev-list", "--verify", "-n", "1", `refs/tags/${releaseTag}^{commit}`]);
const githubRelease = JSON.parse(await command("gh", [
  "api",
  `repos/${githubRepository}/releases/tags/${releaseTag}`,
])) as { tag_name?: string; draft?: boolean };
const npmVersion = await command("npm", [
  "view",
  "--prefer-online",
  `${packageManifest.name}@${packageManifest.version}`,
  "version",
]);

const temporaryDirectory = await mkdtemp(join(os.tmpdir(), "framekit-release-provenance-"));
try {
  const archiveName = `FramekitFinalCutWorkflow-${packageManifest.version}.zip`;
  const checksumName = `${archiveName}.sha256`;
  await command("gh", [
    "release",
    "download",
    releaseTag,
    "--repo",
    githubRepository,
    "--pattern",
    archiveName,
    "--pattern",
    checksumName,
    "--dir",
    temporaryDirectory,
  ]);
  const archiveBytes = await readFile(join(temporaryDirectory, archiveName));
  const checksumContent = await readFile(join(temporaryDirectory, checksumName), "utf8");
  const provenanceInput: ReleaseProvenanceInput = {
    packageManifest,
    pluginManifest,
    serverVersion: FRAMEKIT_VERSION,
    releaseTag,
    githubRelease: {
      tagName: githubRelease.tag_name,
      draft: githubRelease.draft,
    },
    workflow: {
      status: "completed",
      conclusion: "success",
      headSha,
      tagSha,
    },
    npmVersion,
    nativeAssets: [
      { name: archiveName, sha256: sha256(archiveBytes) },
      { name: checksumName, sha256: sha256(Buffer.from(checksumContent)), content: checksumContent },
    ],
  };
  const report = assessReleaseProvenance(provenanceInput);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, "provenance.json"), `${JSON.stringify({
    schemaVersion: 1,
    gate: "v0.1.6-native-editing",
    releaseTag,
    releaseReady: report.releaseReady,
    checks: report.checks.map(({ name, status, detail }) => ({ name, status, detail })),
    summary: report.summary,
  }, null, 2)}\n`, "utf8");
  console.log(`provenance_ready=${report.releaseReady}`);
  console.log(`provenance_checks=${report.checks.map((check) => `${check.name}:${check.status}`).join(",")}`);
  if (!report.releaseReady) process.exitCode = 1;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function command(file: string, args: string[]): Promise<string> {
  const { stdout } = await exec(file, args, {
    cwd: repositoryRoot,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`RELEASE_PROVENANCE_ENV_REQUIRED: ${name}`);
  return value;
}

function assertReleaseIdentity(tag: string, repository: string): void {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("RELEASE_PROVENANCE_INVALID_TAG");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("RELEASE_PROVENANCE_INVALID_REPOSITORY");
  }
}
