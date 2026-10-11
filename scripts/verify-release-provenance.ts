import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  sanitizeCleanMcpEvidence,
  type CleanMcpEvidence,
} from "./clean-mcp-client-evidence.mjs";
import { assessReleaseCandidate } from "./release-candidate-evidence.mjs";
import {
  assessReleaseProvenance,
  type ReleaseProvenanceInput,
} from "../tests/release-gate/native-editing.js";
import { FRAMEKIT_VERSION } from "../apps/mcp-server/src/version.js";

const exec = promisify(execFile);
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
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
const checkoutMatchesTag = headSha.toLowerCase() === tagSha.toLowerCase();
const checkoutIsClean = (await command("git", ["status", "--porcelain", "--untracked-files=all"])).length === 0;
const version = packageManifest.version ?? "";
const nativePackagingResult = await readNativePackagingResult();
const temporaryDirectory = await mkdtemp(join(os.tmpdir(), "framekit-release-provenance-"));

try {
  const githubRelease = await readGithubRelease();
  const npmIdentity = await readNpmIdentity(packageManifest.name ?? "@morshoto/framekit", version);
  const workflowEvidence = await readReleaseWorkflowEvidence(temporaryDirectory);
  const cleanEvidence = sanitizeEvidence(workflowEvidence.evidence);
  const nativeEvidence = await downloadNativeAssets(temporaryDirectory, version);
  const nativeInfo = await readExtensionIdentity(nativeEvidence.archivePath, temporaryDirectory);

  const codex = cleanEvidence?.clients.find((client) => client.name === "Codex");
  const cleanEvidenceMatchesTag = Boolean(
    workflowEvidence.run
    && workflowEvidence.run.status === "completed"
    && workflowEvidence.run.conclusion === "success"
    && cleanEvidence?.passed === true
    && cleanEvidence.environment.sourceClean === true
    && cleanEvidence.environment.gitCommit?.toLowerCase() === tagSha.toLowerCase()
    && cleanEvidence.framekit.version === version
    && cleanEvidence.releaseCandidate?.target.version === version
    && cleanEvidence.releaseCandidate.target.sourceClean === true
    && cleanEvidence.releaseCandidate.target.commit.toLowerCase() === tagSha.toLowerCase(),
  );
  const plugin = cleanEvidenceMatchesTag ? codex?.registration.plugin : undefined;
  const codexDelivery = cleanEvidenceMatchesTag ? codex?.workflow.delivery : undefined;
  const pluginInstalled = Boolean(
    plugin
    && codex?.registration.status === "passed"
    && codexDelivery?.processMode === "headless"
    && codexDelivery.headless.status === "passed"
    && codexDelivery.nativeFinalCut.status,
  );
  const mcpFingerprint = cleanEvidenceMatchesTag ? codex?.server.buildFingerprint : undefined;
  const mcpConnected = Boolean(
    codex
    && codex.registration.packageSource === "published-package"
    && codex.registration.publicPackage?.status === "passed"
    && codex.registration.publicPackage.version === version
    && codex.registration.publicPackage.commit?.toLowerCase() === tagSha.toLowerCase()
    && codex.workflow.delivery?.processMode === "headless"
    && codex.workflow.delivery.headless.status === "passed"
    && codex.workflow.delivery.nativeFinalCut.status
    && mcpFingerprint?.version === version
    && mcpFingerprint.commit.toLowerCase() === tagSha.toLowerCase(),
  );
  const checksumCheck = nativeEvidence.assets
    ? assessReleaseProvenance({ packageManifest, pluginManifest, nativeAssets: nativeEvidence.assets })
        .checks.find((check) => check.name === "native-assets")
    : undefined;
  const nativeSigned = nativePackagingResult === "success";
  const nativeIdentityIssue = nativeEvidence.archivePath && !nativeInfo
    ? "Workflow Extension Info.plist build identity is missing or malformed"
    : undefined;
  const nativeExtension = {
    verified: checkoutMatchesTag && checkoutIsClean && nativeSigned && checksumCheck?.status === "verified" && Boolean(nativeInfo),
    ...(nativeInfo?.version ? { version: nativeInfo.version } : {}),
    ...(nativeInfo?.commit ? { commit: nativeInfo.commit } : {}),
    signed: nativeSigned,
    checksumVerified: checksumCheck?.status === "verified",
    ...(!nativeSigned
      ? { reason: "native release packaging job did not complete successfully" }
      : !checkoutMatchesTag || !checkoutIsClean
        ? { reason: "native release verifier checkout is not the clean exact release tag" }
      : !nativeEvidence.assets
        ? { reason: nativeEvidence.issue }
        : checksumCheck?.status !== "verified"
          ? { reason: "native archive checksum is missing or mismatched" }
          : !nativeInfo
            ? { reason: nativeIdentityIssue ?? "Workflow Extension build identity is unavailable" }
            : {}),
  };
  const candidate = assessReleaseCandidate({
    target: { version, commit: tagSha, sourceClean: checkoutMatchesTag && checkoutIsClean },
    artifacts: {
      npmPackage: {
        available: npmIdentity.version === version,
        ...(npmIdentity.version ? { version: npmIdentity.version } : {}),
        ...(npmIdentity.commit ? { commit: npmIdentity.commit } : {}),
        ...(!npmIdentity.version
          ? { reason: "exact npm package version is unavailable" }
          : !npmIdentity.commit
            ? { reason: "npm registry does not report the published source commit" }
            : {}),
      },
      codexPlugin: {
        installed: pluginInstalled,
        ...(plugin ? { version: plugin.version, commit: plugin.commit } : {}),
        ...(!pluginInstalled ? { reason: cleanEvidenceIssue(cleanEvidenceMatchesTag, workflowEvidence.issue, "Codex plugin install or headless workflow did not pass") } : {}),
      },
      mcpServer: {
        connected: mcpConnected,
        ...(mcpFingerprint ? { version: mcpFingerprint.version, commit: mcpFingerprint.commit } : {}),
        ...(!mcpConnected ? { reason: cleanEvidenceIssue(cleanEvidenceMatchesTag, workflowEvidence.issue, codex?.server.buildFingerprintIssue ?? "published MCP package identity or capability report is incomplete") } : {}),
      },
      nativeExtension,
    },
  });

  const provenanceInput: ReleaseProvenanceInput = {
    packageManifest,
    pluginManifest,
    serverVersion: FRAMEKIT_VERSION,
    releaseTag,
    githubRelease: githubRelease ? {
      tagName: githubRelease.tag_name,
      draft: githubRelease.draft,
    } : undefined,
    workflow: workflowEvidence.run ? {
      status: workflowEvidence.run.status,
      conclusion: workflowEvidence.run.conclusion,
      headSha: workflowEvidence.run.headSha,
      tagSha,
      checkedOutTagSha: cleanEvidence?.environment.gitCommit,
    } : undefined,
    npmVersion: npmIdentity.version,
    nativeAssets: nativeEvidence.assets,
  };
  const report = assessReleaseProvenance(provenanceInput);
  const candidateCheck = {
    name: "release-candidate-artifacts",
    status: candidate.status === "GO" ? "verified" as const : "failed" as const,
    detail: candidate.status === "GO"
      ? "npm package, Codex plugin, MCP server, and signed Workflow Extension match the release tag"
      : `release candidate is NO_GO: ${Object.entries(candidate.artifacts)
        .filter(([, artifact]) => artifact.status === "NO_GO")
        .map(([name]) => name)
        .join(", ")}`,
  };
  const checkoutCheck = {
    name: "native-verifier-checkout",
    status: checkoutMatchesTag && checkoutIsClean ? "verified" as const : "failed" as const,
    detail: checkoutMatchesTag && checkoutIsClean
      ? "native release verifier checked out the exact release tag commit with a clean tree"
      : "native release verifier checkout is dirty or does not match the release tag commit",
  };
  const releaseReady = report.releaseReady && checkoutMatchesTag && checkoutIsClean && candidate.status === "GO";
  const checks = [...report.checks, checkoutCheck, candidateCheck];
  const workflowRun = workflowEvidence.run ? {
    databaseId: workflowEvidence.run.databaseId,
    status: workflowEvidence.run.status,
    conclusion: workflowEvidence.run.conclusion,
    headSha: workflowEvidence.run.headSha,
    event: workflowEvidence.run.event,
    checkedOutTagSha: cleanEvidence?.environment.gitCommit,
  } : undefined;

  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, "provenance.json"), `${JSON.stringify({
    schemaVersion: 2,
    evidenceType: "framekit-release-provenance",
    gate: "installable-release-artifacts",
    releaseTag,
    target: { version, commit: tagSha },
    goNoGo: releaseReady ? "GO" : "NO_GO",
    releaseReady,
    nativePackagingResult,
    ...(workflowRun ? { workflowRun } : {}),
    releaseCandidate: candidate,
    checks,
    summary: releaseReady
      ? "release provenance and installable artifacts match the exact release tag"
      : `${report.summary}; ${candidateCheck.detail}`,
  }, null, 2)}\n`, "utf8");

  console.log(`release_candidate=${candidate.status}`);
  console.log(`provenance_ready=${releaseReady}`);
  console.log(`provenance_checks=${checks.map((check) => `${check.name}:${check.status}`).join(",")}`);
  if (!releaseReady) process.exitCode = 1;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function readGithubRelease(): Promise<{ tag_name?: string; draft?: boolean } | undefined> {
  try {
    return JSON.parse(await command("gh", ["api", `repos/${githubRepository}/releases/tags/${releaseTag}`])) as {
      tag_name?: string;
      draft?: boolean;
    };
  } catch {
    return undefined;
  }
}

async function readNativePackagingResult(): Promise<string> {
  const runId = process.env.GITHUB_RUN_ID;
  if (!runId || !/^\d+$/.test(runId)) return "unavailable";
  try {
    const jobs = await command("gh", [
      "api",
      `repos/${githubRepository}/actions/runs/${runId}/jobs`,
      "--jq",
      '.jobs[] | select(.name == "Package signed native assets") | [.status, (.conclusion // "")] | @tsv',
    ]);
    const [status, conclusion] = jobs.split(/\r?\n/)[0]?.split("\t") ?? [];
    if (!status) return "unavailable";
    return status === "completed" ? conclusion || "unavailable" : status;
  } catch {
    return "unavailable";
  }
}

async function readNpmIdentity(packageName: string, packageVersion: string): Promise<{ version?: string; commit?: string }> {
  if (!packageVersion) return {};
  const specifier = `${packageName}@${packageVersion}`;
  const [publishedVersion, commit] = await Promise.all([
    optionalCommand("npm", ["view", "--prefer-online", specifier, "version"]),
    optionalCommand("npm", ["view", "--prefer-online", specifier, "gitHead"]),
  ]);
  return {
    ...(publishedVersion ? { version: publishedVersion } : {}),
    ...(commit && /^[0-9a-f]{40}$/i.test(commit) ? { commit: commit.toLowerCase() } : {}),
  };
}

interface ReleaseWorkflowRun {
  databaseId: number;
  status: string;
  conclusion?: string;
  headSha?: string;
  event?: string;
  createdAt?: string;
}

interface ReleaseWorkflowEvidence {
  run?: ReleaseWorkflowRun;
  evidence?: unknown;
  issue?: string;
}

async function readReleaseWorkflowEvidence(temporaryDirectory: string): Promise<ReleaseWorkflowEvidence> {
  let runs: ReleaseWorkflowRun[];
  try {
    runs = JSON.parse(await command("gh", [
      "run", "list",
      "--repo", githubRepository,
      "--workflow", "release.yml",
      "--limit", "100",
      "--json", "databaseId,status,conclusion,headSha,event,createdAt",
    ])) as ReleaseWorkflowRun[];
  } catch {
    return { issue: "release workflow history is unavailable" };
  }

  const successfulRuns = runs
    .filter((run) => run.status === "completed" && run.conclusion === "success")
    .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
  for (const run of successfulRuns) {
    const artifactDirectory = join(temporaryDirectory, `release-run-${run.databaseId}`);
    await mkdir(artifactDirectory, { recursive: true });
    try {
      await command("gh", [
        "run", "download", String(run.databaseId),
        "--repo", githubRepository,
        "--name", `clean-mcp-clients-${releaseTag}`,
        "--dir", artifactDirectory,
      ]);
      const artifact = JSON.parse(await readFile(join(artifactDirectory, "clean-mcp-clients.json"), "utf8")) as unknown;
      return { run, evidence: artifact };
    } catch {
      // Older or unrelated release runs may not contain this tag's clean install artifact.
    }
  }
  return {
    run: successfulRuns[0],
    issue: successfulRuns.length === 0
      ? "no completed successful release workflow run is available"
      : "clean MCP evidence for this release tag is unavailable",
  };
}

function sanitizeEvidence(value: unknown): CleanMcpEvidence | undefined {
  if (!value) return undefined;
  try {
    return sanitizeCleanMcpEvidence(value, { expectedClientNames: ["Codex"] });
  } catch {
    return undefined;
  }
}

interface NativeAssetEvidence {
  assets?: Array<{ name: string; sha256?: string; content?: string }>;
  archivePath?: string;
  issue?: string;
  identityIssue?: string;
}

async function downloadNativeAssets(temporaryDirectory: string, packageVersion: string): Promise<NativeAssetEvidence> {
  const archiveName = `FramekitFinalCutWorkflow-${packageVersion}.zip`;
  const checksumName = `${archiveName}.sha256`;
  try {
    await command("gh", [
      "release", "download", releaseTag,
      "--repo", githubRepository,
      "--pattern", archiveName,
      "--pattern", checksumName,
      "--dir", temporaryDirectory,
    ]);
    const archivePath = join(temporaryDirectory, archiveName);
    const archiveBytes = await readFile(archivePath);
    const checksumContent = await readFile(join(temporaryDirectory, checksumName), "utf8");
    return {
      archivePath,
      assets: [
        { name: archiveName, sha256: sha256(archiveBytes) },
        { name: checksumName, sha256: sha256(Buffer.from(checksumContent)), content: checksumContent },
      ],
    };
  } catch {
    return { issue: "signed native release archive or checksum is unavailable" };
  }
}

async function readExtensionIdentity(
  archivePath: string | undefined,
  temporaryDirectory: string,
): Promise<{ version?: string; commit?: string } | undefined> {
  if (!archivePath) return undefined;
  try {
    const archiveEntries = await command("unzip", ["-Z1", archivePath]);
    const plistPaths = archiveEntries.split(/\r?\n/).filter((entry) =>
      /FramekitFinalCutWorkflowExtension\.appex\/Contents\/Info\.plist$/.test(entry),
    );
    if (plistPaths.length !== 1) return undefined;
    const plistPath = join(temporaryDirectory, "FramekitFinalCutWorkflow-Info.plist");
    const plistBytes = await commandBuffer("unzip", ["-p", archivePath, plistPaths[0]]);
    await writeFile(plistPath, plistBytes);
    const parsed = JSON.parse(await command("python3", [
      "-c",
      "import json, plistlib, sys; p=plistlib.load(open(sys.argv[1], 'rb')); print(json.dumps({'version': p.get('FramekitBuildVersion'), 'commit': p.get('FramekitBuildCommit')}))",
      plistPath,
    ])) as { version?: unknown; commit?: unknown };
    if (typeof parsed.version !== "string" || typeof parsed.commit !== "string") return undefined;
    if (!/^\d+\.\d+\.\d+$/.test(parsed.version) || !/^[0-9a-f]{40}$/i.test(parsed.commit)) return undefined;
    return { version: parsed.version, commit: parsed.commit.toLowerCase() };
  } catch {
    return undefined;
  }
}

function cleanEvidenceIssue(matchesTag: boolean, workflowIssue: string | undefined, fallback: string): string {
  if (!matchesTag) return workflowIssue ?? "clean MCP evidence does not match the exact release tag";
  return fallback;
}

async function command(file: string, args: string[]): Promise<string> {
  const { stdout } = await exec(file, args, {
    cwd: repositoryRoot,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

async function optionalCommand(file: string, args: string[]): Promise<string | undefined> {
  try {
    return await command(file, args);
  } catch {
    return undefined;
  }
}

async function commandBuffer(file: string, args: string[]): Promise<Buffer> {
  return new Promise((resolveBuffer, reject) => {
    execFile(file, args, { cwd: repositoryRoot, encoding: null, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else if (Buffer.isBuffer(stdout)) resolveBuffer(stdout);
      else reject(new Error("RELEASE_PROVENANCE_BINARY_OUTPUT_INVALID"));
    });
  });
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
