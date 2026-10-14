import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sanitizeCleanMcpEvidence } from "./clean-mcp-client-evidence.mjs";
import { assertMcpServerVersion } from "./mcp-version.mjs";
import { assessReleaseCandidate } from "./release-candidate-evidence.mjs";

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageName = "@morshoto/framekit";
const claudeVersion = process.env.CLAUDE_CODE_VERSION ?? "2.1.231";
const clientSelection = process.env.FRAMEKIT_CLEAN_CLIENT ?? "all";
const requiredTools = [
  ["headless.project.create", "passed"],
  ["headless.project.inspect", "passed"],
  ["speech.analyze", "passed"],
  ["headless.edit.preview", "passed"],
  ["headless.edit.execute", "passed"],
  ["editing.route", "headless-selected"],
];

class RecordingMcpClient extends Client {
  negotiatedProtocolVersion;

  async request(request, resultSchema, options) {
    const result = await super.request(request, resultSchema, options);
    if (request?.method === "initialize") {
      if (typeof result?.protocolVersion !== "string" || result.protocolVersion.length === 0) {
        throw new Error("MCP initialize response did not include a protocol version");
      }
      this.negotiatedProtocolVersion = result.protocolVersion;
    }
    return result;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export async function main() {
  const expectedClientNames = expectedClientNamesForSelection(clientSelection);
  const packageManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const runtimeManifest = JSON.parse(await readFile(join(root, "packages/runtime/package.json"), "utf8"));
  const environment = await evidenceEnvironment();
  const releaseTag = process.env.RELEASE_TAG ?? `v${packageManifest.version}`;
  const candidateVersion = releaseTag.replace(/^v/, "");
  const candidateCommit = process.env.RELEASE_COMMIT?.trim() ?? environment.gitCommit;
  if (!/^v\d+\.\d+\.\d+$/.test(releaseTag) || !/^[0-9a-f]{40}$/i.test(candidateCommit)) {
    throw new Error("RELEASE_CANDIDATE_IDENTITY_INVALID: provide a release tag and full commit SHA");
  }
  const packageStatus = await inspectPublishedPackage(candidateVersion, candidateCommit);
  const packageDirectory = await mkdtemp(join(os.tmpdir(), "framekit-clean-package-"));
  const installDirectory = await mkdtemp(join(os.tmpdir(), "framekit-clean-install-"));
  const stateDirectory = await mkdtemp(join(os.tmpdir(), "framekit-clean-state-"));

  try {
    const installedPackage = await installCleanPackage(
      packageDirectory,
      installDirectory,
      packageStatus,
      packageManifest.version,
    );
    const clients = [];

    if (clientSelection === "all" || clientSelection === "codex") {
      clients.push(await runCodexWorkflow(
        installedPackage.executable,
        installedPackage.version,
        packageStatus,
        installedPackage.source,
        stateDirectory,
      ));
    }
    if (clientSelection === "all" || clientSelection === "claude") {
      clients.push(await runClaudeWorkflow(
        installedPackage.executable,
        installedPackage.version,
        packageStatus,
        installedPackage.source,
        stateDirectory,
      ));
    }
    const nativeExtension = await inspectNativeProvenance(candidateVersion, candidateCommit);
    const codexClient = clients.find((client) => client.name === "Codex");
    const mcpClient = clients[0];
    const releaseCandidate = assessReleaseCandidate({
      target: {
        version: candidateVersion,
        commit: candidateCommit,
        sourceClean: environment.sourceClean,
      },
      artifacts: {
        npmPackage: packageStatus,
        codexPlugin: {
          installed: Boolean(codexClient),
          ...(codexClient?.registration.plugin ?? {}),
          ...(!codexClient ? { reason: "Codex plugin installation was not selected" } : {}),
        },
        mcpServer: {
          connected: Boolean(mcpClient),
          ...(mcpClient ? { version: mcpClient.server.version } : {}),
          ...(mcpClient?.server.buildFingerprint ?? {}),
          ...(mcpClient?.server.buildFingerprintIssue
            ? { reason: mcpClient.server.buildFingerprintIssue }
            : {}),
          ...(!mcpClient ? { reason: "no production MCP client run was selected" } : {}),
        },
        nativeExtension,
      },
    });
    const evidence = sanitizeCleanMcpEvidence({
      schemaVersion: 1,
      passed: true,
      recordedAt: new Date().toISOString(),
      framekit: { version: packageManifest.version, packageName },
      runtime: { version: runtimeManifest.version, packageName: "@framekit/runtime" },
      environment,
      clients,
      releaseCandidate,
    }, { expectedClientNames });
    const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
    const evidenceOutput = process.env.FRAMEKIT_CLEAN_MCP_EVIDENCE_OUTPUT;
    if (evidenceOutput) {
      await mkdir(dirname(resolve(evidenceOutput)), { recursive: true });
      await writeFile(resolve(evidenceOutput), serialized, "utf8");
    }
    process.stdout.write(serialized);
  } finally {
    await rm(packageDirectory, { recursive: true, force: true });
    await rm(installDirectory, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

function expectedClientNamesForSelection(selection) {
  if (selection === "all") return ["Codex", "Claude Code"];
  if (selection === "codex") return ["Codex"];
  if (selection === "claude") return ["Claude Code"];
  throw new Error("FRAMEKIT_CLEAN_CLIENT must be all, codex, or claude");
}

async function runCodexWorkflow(executable, framekitVersion, packageStatus, packageSource, stateDirectory) {
  const codexHome = await mkdtemp(join(os.tmpdir(), "framekit-clean-codex-"));
  try {
    const marketplace = await runJson("codex", ["plugin", "marketplace", "add", root, "--json"], {
      CODEX_HOME: codexHome,
    });
    if (marketplace.marketplaceName !== "framekit") throw new Error("Codex did not add the Framekit marketplace");
    const installed = await runJson("codex", ["plugin", "add", "framekit@framekit", "--json"], {
      CODEX_HOME: codexHome,
    });
    if (installed.pluginId !== "framekit@framekit") throw new Error("Codex did not install the Framekit plugin");
    if (installed.version !== framekitVersion) throw new Error("Codex plugin version does not match the installed MCP package");
    const servers = await runJson("codex", ["mcp", "list", "--json"], { CODEX_HOME: codexHome });
    const server = servers.find((candidate) => candidate.name === "framekit");
    if (!server?.enabled) throw new Error("Codex did not expose an enabled Framekit MCP server");

    const workflow = await runMcpWorkflow({
      clientName: "framekit-codex-clean-validation",
      clientVersion: await commandVersion("codex", ["--version"]),
      executable,
      framekitVersion,
      packageSource,
      stateDirectory,
    });
    return {
      ...workflow,
      name: "Codex",
      clientVersion: await commandVersion("codex", ["--version"]),
      registration: {
        status: "passed",
        command: "codex plugin marketplace add <release-checkout>; codex plugin add framekit@framekit",
        publicPackage: packageStatus,
        plugin: { version: installed.version },
        packageSource,
      },
    };
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}

async function runClaudeWorkflow(executable, framekitVersion, packageStatus, packageSource, stateDirectory) {
  const clientDirectory = await mkdtemp(join(os.tmpdir(), "framekit-clean-claude-install-"));
  const configDirectory = await mkdtemp(join(os.tmpdir(), "framekit-clean-claude-config-"));
  try {
    const claude = await ensureClaudeBinary(clientDirectory);
    const registrationCommand = "claude mcp add --env FRAMEKIT_EDITOR=final-cut-live --scope user --transport stdio framekit -- npx -y @morshoto/framekit mcp --headless";
    const add = await runCommand(claude, [
      "mcp", "add", "--env", "FRAMEKIT_EDITOR=final-cut-live", "--scope", "user", "--transport", "stdio", "framekit", "--",
      "npx", "-y", packageName, "mcp", "--headless",
    ], { CLAUDE_CONFIG_DIR: configDirectory });
    if (!/^Added stdio MCP server framekit/m.test(add.stdout)) throw new Error("Claude Code did not add the Framekit MCP server");
    await runCommand(claude, ["mcp", "list"], { CLAUDE_CONFIG_DIR: configDirectory });

    const workflow = await runMcpWorkflow({
      clientName: "framekit-claude-clean-validation",
      clientVersion: await commandVersion(claude, ["--version"]),
      executable,
      framekitVersion,
      packageSource,
      stateDirectory,
    });
    return {
      ...workflow,
      name: "Claude Code",
      clientVersion: await commandVersion(claude, ["--version"]),
      registration: { status: "passed", command: registrationCommand, publicPackage: packageStatus, packageSource },
    };
  } finally {
    await rm(clientDirectory, { recursive: true, force: true });
    await rm(configDirectory, { recursive: true, force: true });
  }
}

async function runMcpWorkflow({ clientName, clientVersion, executable, framekitVersion, packageSource, stateDirectory }) {
  const transport = new StdioClientTransport({
    command: executable,
    args: ["mcp", "--editor", "fixture"],
    env: {
      ...process.env,
      FRAMEKIT_BUILD_COMMIT: "",
      FRAMEKIT_STATE_DIR: stateDirectory,
    },
    stderr: "pipe",
  });
  const client = new RecordingMcpClient({ name: clientName, version: clientVersion });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const requiredToolNames = [
      "connection.status",
      "editor.inspect",
      ...requiredTools.map(([name]) => name),
    ];
    for (const name of requiredToolNames) {
      if (!tools.tools.some((tool) => tool.name === name)) throw new Error(`${name} is not available to ${clientName}`);
    }

    const connection = await callJson(client, "connection.status");
    if (connection.state !== "ready") throw new Error(`${clientName} connection status was not ready`);
    const editor = await callJson(client, "editor.inspect");
    const headlessTimeline = emptyHeadlessTimeline(randomUUID());
    const created = await callJson(client, "headless.project.create", { timeline: headlessTimeline });
    const projectId = headlessTimeline.project.id;
    const sequenceId = headlessTimeline.sequence.id;
    const route = await callJson(client, "editing.route", {
      operation: "timeline.edit",
      editType: "add-title",
    });
    if (route.status !== "headless-selected" || route.selectedPath !== "headless") {
      throw new Error(`${clientName} did not select the headless editing route`);
    }
    const initial = await callJson(client, "headless.project.inspect", { projectId });
    if (initial.timeline.project.id !== projectId || initial.timeline.sequence.id !== sequenceId) {
      throw new Error(`${clientName} did not inspect the newly created headless project`);
    }
    const analysis = await callJson(client, "speech.analyze", { mediaId: "media-1" });
    if (analysis.words?.[0]?.filler !== true) throw new Error(`${clientName} analysis workflow did not return the filler fixture`);
    const operations = [{
      type: "add-title",
      title: {
        id: "clean-install-title",
        text: "Clean install",
        startTime: { value: "0", timescale: "1" },
        durationTime: { value: "1", timescale: "2" },
        lane: 1,
      },
    }];
    const request = {
      projectId,
      sequenceId,
      expectedRevision: created.timeline.revision,
      operations,
    };
    const preview = await callJson(client, "headless.edit.preview", request);
    if (preview.before.timeline.sequence.titles?.length !== 0) {
      throw new Error(`${clientName} headless preview did not preserve the empty starting revision`);
    }
    const executed = await callJson(client, "headless.edit.execute", request);
    const after = await callJson(client, "headless.project.inspect", { projectId });
    if (after.timeline.revision.id !== executed.after.timeline.revision.id
      || after.timeline.sequence.titles?.[0]?.text !== "Clean install") {
      throw new Error(`${clientName} headless edit was not persisted at the reported revision`);
    }

    const serverInfo = client.getServerVersion?.();
    const serverVersion = assertMcpServerVersion(serverInfo?.version, framekitVersion, clientName);
    const protocolVersion = client.negotiatedProtocolVersion;
    if (!protocolVersion) throw new Error(`${clientName} did not negotiate an MCP protocol version`);
    const buildFingerprint = editor.preflight?.fingerprint;
    const validBuildFingerprint = buildFingerprint?.version === serverVersion
      && /^[0-9a-f]{40}$/i.test(buildFingerprint?.commit ?? "");
    const buildFingerprintIssue = validBuildFingerprint
      ? undefined
      : buildFingerprint?.version !== serverVersion
        ? "MCP server build fingerprint version is missing or mismatched"
        : "MCP server build fingerprint does not include a full commit SHA";
    const processMode = editor.preflight?.processMode ?? "unknown";
    if (processMode !== "headless") throw new Error(`${clientName} MCP did not report headless process mode`);

    return {
      name: "pending",
      clientVersion,
      server: {
        version: serverVersion,
        protocolVersion,
        ...(validBuildFingerprint ? { buildFingerprint } : {}),
        ...(buildFingerprintIssue ? { buildFingerprintIssue } : {}),
      },
      editor: editor.identity,
      capabilities: editor.capabilities,
      workflow: {
        tools: [
          { name: "headless.project.create", status: "passed" },
          { name: "headless.project.inspect", status: "passed" },
          { name: "speech.analyze", status: "passed" },
          { name: "headless.edit.preview", status: "passed" },
          { name: "headless.edit.execute", status: "passed" },
          { name: "editing.route", status: "headless-selected" },
        ],
        limitations: [
          "CAPABILITY_UNAVAILABLE: native Final Cut import and readback are not exercised by the fixture workflow",
          ...(packageSource === "packed-source"
            ? ["CAPABILITY_UNAVAILABLE: the exact published npm package is unavailable"]
            : []),
          ...(buildFingerprintIssue ? [`BUILD_IDENTITY_UNAVAILABLE: ${buildFingerprintIssue}`] : []),
        ],
        delivery: {
          processMode,
          headless: {
            status: "passed",
            backend: editor.identity?.backend ?? "unknown",
            requiredCapabilities: route.requiredCapabilities ?? [],
          },
          nativeFinalCut: {
            status: "blocked",
            reason: "the clean MCP workflow uses a fixture editor and does not inspect the installed Workflow Extension",
          },
        },
      },
    };
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

async function installCleanPackage(packageDirectory, installDirectory, packageStatus, sourceVersion) {
  let source = "published-package";
  let installSpec = `${packageName}@${packageStatus.version}`;
  if (!packageStatus.available) {
    source = "packed-source";
    const packed = JSON.parse((await execFile("npm", ["pack", "--json", "--pack-destination", packageDirectory], {
      cwd: root,
      maxBuffer: 10 * 1024 * 1024,
    })).stdout);
    installSpec = join(packageDirectory, packed[0].filename);
  }
  await execFile("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", installSpec], {
    cwd: installDirectory,
    maxBuffer: 10 * 1024 * 1024,
  });
  const installedManifest = JSON.parse(await readFile(
    join(installDirectory, "node_modules", ...packageName.split("/"), "package.json"),
    "utf8",
  ));
  if (typeof installedManifest.version !== "string") throw new Error("MCP package installation did not include its version");
  if (source === "packed-source" && installedManifest.version !== sourceVersion) {
    throw new Error("MCP package version changed during the packed-source install");
  }
  return {
    executable: join(installDirectory, "node_modules", ".bin", "framekit"),
    version: installedManifest.version,
    source,
  };
}

async function ensureClaudeBinary(directory) {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const candidate = join(directory, "node_modules", ".bin", "claude");
  await execFile("npm", ["install", "--prefix", directory, "--no-save", "--no-audit", "--no-fund", `@anthropic-ai/claude-code@${claudeVersion}`], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return candidate;
}

async function inspectPublishedPackage(version, expectedCommit) {
  try {
    const { stdout } = await execFile("npm", ["view", `${packageName}@${version}`, "version", "gitHead", "--json"], { maxBuffer: 1024 * 1024 });
    const metadata = JSON.parse(stdout);
    const gitHead = typeof metadata?.gitHead === "string" ? metadata.gitHead : undefined;
    const available = metadata?.version === version;
    const matched = available && gitHead?.toLowerCase() === expectedCommit.toLowerCase();
    return {
      available,
      status: !available ? "blocked" : matched ? "passed" : "mismatched",
      ...(available ? { version: metadata.version } : {}),
      ...(gitHead ? { commit: gitHead } : {}),
      ...(!available
        ? { reason: `${packageName}@${version} is not published` }
        : !gitHead
          ? { reason: "npm registry metadata does not include the published commit" }
          : !matched
            ? { reason: "published npm commit does not match the release candidate" }
            : {}),
    };
  } catch (error) {
    const diagnostic = `${error?.stderr ?? ""} ${error?.stdout ?? ""}`;
    const missing = /E404|404|No match found for version/i.test(diagnostic);
    return {
      available: false,
      status: "blocked",
      reason: missing
        ? `${packageName}@${version} is not published`
        : "npm registry metadata is unavailable",
    };
  }
}

async function inspectNativeProvenance(version, commit) {
  const evidencePath = process.env.FRAMEKIT_NATIVE_PROVENANCE_EVIDENCE;
  if (!evidencePath) return { verified: false, reason: "signed native release provenance was not supplied" };
  try {
    const report = JSON.parse(await readFile(resolve(evidencePath), "utf8"));
    const target = report.releaseCandidate?.target;
    const nativeExtension = report.releaseCandidate?.artifacts?.nativeExtension;
    const identityMatches = target?.version === version && target?.commit?.toLowerCase() === commit.toLowerCase();
    if (!identityMatches || report.releaseCandidate?.status !== "GO" || nativeExtension?.status !== "GO") {
      return { verified: false, reason: "native provenance does not show GO for the exact release candidate" };
    }
    return {
      verified: true,
      signed: true,
      checksumVerified: true,
      version: nativeExtension.version,
      commit: nativeExtension.commit,
    };
  } catch {
    return { verified: false, reason: "native provenance evidence is unavailable or invalid" };
  }
}

function emptyHeadlessTimeline(projectId) {
  return {
    schemaVersion: 1,
    project: { id: projectId, name: "Framekit Clean Install" },
    sequence: {
      id: `${projectId}-sequence`,
      name: "Master",
      durationTime: { value: "0", timescale: "1" },
      frameDuration: { value: "1", timescale: "30" },
      occurrences: [],
      storyElements: [],
      markers: [],
      captions: [],
      titles: [],
      transitions: [],
    },
    resources: [],
    revision: { id: `${projectId}-revision-0`, sequence: 0, timestamp: new Date().toISOString() },
  };
}

async function evidenceEnvironment() {
  const { stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd: root });
  const { stdout: gitStatus } = await execFile("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root });
  return {
    gitCommit: stdout.trim(),
    sourceClean: gitStatus.trim().length === 0,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    osVersion: os.version(),
  };
}

async function commandVersion(command, args) {
  const { stdout } = await execFile(command, args, { maxBuffer: 1024 * 1024 });
  return stdout.trim().replace(/^codex-cli\s+/, "").replace(/\s+\(Claude Code\)$/, "");
}

async function runJson(command, args, env) {
  const { stdout } = await runCommand(command, args, env);
  return JSON.parse(stdout);
}

async function runCommand(command, args, env = {}) {
  return execFile(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function callJson(client, name, arguments_ = {}) {
  const result = await client.callTool({ name, arguments: arguments_ });
  const text = result.content?.find((item) => item.type === "text")?.text ?? "";
  if (result.isError) throw new Error(text || `${name} failed`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${name} returned invalid JSON: ${text}`);
  }
}
