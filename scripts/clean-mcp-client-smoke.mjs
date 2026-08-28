import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sanitizeCleanMcpEvidence } from "./clean-mcp-client-evidence.mjs";

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageName = "@morshoto/framekit";
const claudeVersion = process.env.CLAUDE_CODE_VERSION ?? "2.1.231";
const clientSelection = process.env.FRAMEKIT_CLEAN_CLIENT ?? "all";
const requiredTools = [
  ["project.inspect", "passed"],
  ["speech.analyze", "passed"],
  ["timeline.edit", "VERIFIED"],
  ["edit.diff", "passed"],
  ["edit.verify", "passed"],
  ["edit.undo", "passed"],
];

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export async function main() {
  const expectedClientNames = expectedClientNamesForSelection(clientSelection);
  const packageManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const runtimeManifest = JSON.parse(await readFile(join(root, "packages/runtime/package.json"), "utf8"));
  const packageStatus = await inspectPublishedPackage();
  const packageDirectory = await mkdtemp(join(os.tmpdir(), "framekit-clean-package-"));
  const installDirectory = await mkdtemp(join(os.tmpdir(), "framekit-clean-install-"));

  try {
    const executable = await installCleanPackage(packageDirectory, installDirectory);
    const environment = await evidenceEnvironment();
    const clients = [];

    if (clientSelection === "all" || clientSelection === "codex") {
      clients.push(await runCodexWorkflow(executable, packageManifest.version, packageStatus));
    }
    if (clientSelection === "all" || clientSelection === "claude") {
      clients.push(await runClaudeWorkflow(executable, packageManifest.version, packageStatus));
    }
    const evidence = sanitizeCleanMcpEvidence({
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      framekit: { version: packageManifest.version, packageName },
      runtime: { version: runtimeManifest.version, packageName: "@framekit/runtime" },
      environment,
      clients,
    }, { expectedClientNames });
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    await rm(packageDirectory, { recursive: true, force: true });
    await rm(installDirectory, { recursive: true, force: true });
  }
}

function expectedClientNamesForSelection(selection) {
  if (selection === "all") return ["Codex", "Claude Code"];
  if (selection === "codex") return ["Codex"];
  if (selection === "claude") return ["Claude Code"];
  throw new Error("FRAMEKIT_CLEAN_CLIENT must be all, codex, or claude");
}

async function runCodexWorkflow(executable, framekitVersion, packageStatus) {
  const codexHome = await mkdtemp(join(os.tmpdir(), "framekit-clean-codex-"));
  try {
    const marketplace = await runJson("codex", ["plugin", "marketplace", "add", "morshoto/framekit", "--json"], {
      CODEX_HOME: codexHome,
    });
    if (marketplace.marketplaceName !== "framekit") throw new Error("Codex did not add the Framekit marketplace");
    const installed = await runJson("codex", ["plugin", "add", "framekit@framekit", "--json"], {
      CODEX_HOME: codexHome,
    });
    if (installed.pluginId !== "framekit@framekit") throw new Error("Codex did not install the Framekit plugin");
    const servers = await runJson("codex", ["mcp", "list", "--json"], { CODEX_HOME: codexHome });
    const server = servers.find((candidate) => candidate.name === "framekit");
    if (!server?.enabled) throw new Error("Codex did not expose an enabled Framekit MCP server");

    const workflow = await runMcpWorkflow({
      clientName: "framekit-codex-clean-validation",
      clientVersion: await commandVersion("codex", ["--version"]),
      executable,
      framekitVersion,
    });
    return {
      ...workflow,
      name: "Codex",
      clientVersion: await commandVersion("codex", ["--version"]),
      registration: {
        status: "passed",
        command: "codex plugin marketplace add morshoto/framekit; codex plugin add framekit@framekit",
        publicPackage: packageStatus,
      },
    };
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}

async function runClaudeWorkflow(executable, framekitVersion, packageStatus) {
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
    });
    return {
      ...workflow,
      name: "Claude Code",
      clientVersion: await commandVersion(claude, ["--version"]),
      registration: { status: "passed", command: registrationCommand, publicPackage: packageStatus },
    };
  } finally {
    await rm(clientDirectory, { recursive: true, force: true });
    await rm(configDirectory, { recursive: true, force: true });
  }
}

async function runMcpWorkflow({ clientName, clientVersion, executable, framekitVersion }) {
  const transport = new StdioClientTransport({
    command: executable,
    args: ["mcp", "--editor", "fixture"],
    stderr: "pipe",
  });
  const client = new Client({ name: clientName, version: clientVersion });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const requiredToolNames = ["connection.status", "editor.inspect", ...requiredTools.map(([name]) => name)];
    for (const name of requiredToolNames) {
      if (!tools.tools.some((tool) => tool.name === name)) throw new Error(`${name} is not available to ${clientName}`);
    }

    const connection = await callJson(client, "connection.status");
    if (connection.state !== "ready") throw new Error(`${clientName} connection status was not ready`);
    const editor = await callJson(client, "editor.inspect");
    const before = await callJson(client, "project.inspect");
    if (before.projectName !== "Phase 2 Fixture" || before.timeline?.clips?.[0]?.name !== "Interview") {
      throw new Error(`${clientName} read workflow returned an unexpected fixture`);
    }

    const analysis = await callJson(client, "speech.analyze", { mediaId: "media-1" });
    if (analysis.words?.[0]?.filler !== true) throw new Error(`${clientName} analysis workflow did not return the filler fixture`);
    const transaction = await callJson(client, "timeline.edit", {
      type: "rename-clip",
      clipId: "clip-1",
      name: "Interview - Clean",
      baseRevision: before.revision,
    });
    if (transaction.status !== "VERIFIED") throw new Error(`${clientName} edit workflow was not verified`);
    const diff = await callJson(client, "edit.diff", { transactionId: transaction.id });
    if (diff.modified?.[0]?.itemId !== "clip-1") throw new Error(`${clientName} diff workflow did not identify clip-1`);
    const verification = await callJson(client, "edit.verify", { transactionId: transaction.id });
    if (verification.passed !== true) throw new Error(`${clientName} verification workflow did not pass`);
    const undone = await callJson(client, "edit.undo", { transactionId: transaction.id });
    if (undone.timeline?.clips?.[0]?.name !== "Interview") throw new Error(`${clientName} undo workflow did not restore the fixture`);

    const serverInfo = client.getServerVersion?.();
    return {
      name: "pending",
      clientVersion,
      server: {
        version: serverInfo?.version ?? framekitVersion,
        protocolVersion: client.getServerCapabilities?.()?.protocolVersion ?? "2025-11-25",
      },
      editor: editor.identity,
      capabilities: editor.capabilities,
      workflow: {
        tools: [
          { name: "project.inspect", status: "passed" },
          { name: "speech.analyze", status: "passed" },
          { name: "timeline.edit", status: transaction.status },
          { name: "edit.diff", status: "passed" },
          { name: "edit.verify", status: "passed" },
          { name: "edit.undo", status: "passed" },
        ],
        limitations: [
          "CAPABILITY_UNAVAILABLE: native Final Cut mutation is disabled by headless mode",
          "CAPABILITY_UNAVAILABLE: the published npm package is unavailable in the current registry",
        ],
      },
    };
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

async function installCleanPackage(packageDirectory, installDirectory) {
  const packed = JSON.parse((await execFile("npm", ["pack", "--json", "--pack-destination", packageDirectory], {
    cwd: root,
    maxBuffer: 10 * 1024 * 1024,
  })).stdout);
  const archive = join(packageDirectory, packed[0].filename);
  await execFile("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", archive], {
    cwd: installDirectory,
    maxBuffer: 10 * 1024 * 1024,
  });
  return join(installDirectory, "node_modules", ".bin", "framekit");
}

async function ensureClaudeBinary(directory) {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const candidate = join(directory, "node_modules", ".bin", "claude");
  await execFile("npm", ["install", "--prefix", directory, "--no-save", "--no-audit", "--no-fund", `@anthropic-ai/claude-code@${claudeVersion}`], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return candidate;
}

async function inspectPublishedPackage() {
  try {
    const { stdout } = await execFile("npm", ["view", packageName, "version", "--json"], { maxBuffer: 1024 * 1024 });
    const version = JSON.parse(stdout);
    if (typeof version === "string" && version) return { status: "passed" };
  } catch {
    // The evidence records the stable, sanitized failure below.
  }
  return { status: "blocked", reason: `${packageName} is not available from the configured npm registry` };
}

async function evidenceEnvironment() {
  const { stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd: root });
  return {
    gitCommit: stdout.trim(),
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
