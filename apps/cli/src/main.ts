import { execFile as execFileCallback, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { FinalCutConnectionManager } from "@framekit/final-cut";

const execFile = promisify(execFileCallback);
type StatusOutput = Pick<NodeJS.WriteStream, "write">;

export interface McpStartupDependencies {
  connectDevelopmentExtension?: (args: string[], output: StatusOutput) => Promise<ReturnType<FinalCutConnectionManager["getStatus"]>>;
  spawnChild?: typeof spawn;
  stderr?: StatusOutput;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--") argv.shift();
  const [command = "help", ...args] = argv;
  if (command === "connect") {
    await connectFinalCut(args);
    return;
  }
  if (command === "doctor") {
    await doctorFinalCut(args);
    return;
  }
  if (command === "mcp") {
    await runMcp(args);
    return;
  }
  printHelp();
  if (command !== "help") process.exitCode = 1;
}

async function connectFinalCut(
  args: string[],
  output: StatusOutput = process.stdout,
): Promise<ReturnType<FinalCutConnectionManager["getStatus"]>> {
  if (args[0] !== "finalcut") {
    throw new Error("Usage: framekit connect finalcut [--development] [--json]");
  }
  const development = args.includes("--development");
  const json = args.includes("--json");
  let extensionSourcePath = process.env.FRAMEKIT_EXTENSION_APP_PATH;
  if (development) {
    await buildDevelopmentExtension();
    extensionSourcePath = join("/tmp", "framekit-finalcut-derived/Build/Products/Debug/FramekitFinalCutWorkflow.app");
  }
  const manager = new FinalCutConnectionManager({
    extensionSourcePath,
    restartAfterInstall: true,
    installBeforeProbe: development,
  });
  const status = await manager.ensureConnected();
  printStatus(status, json, output);
  if (status.state !== "ready") process.exitCode = 1;
  return status;
}

async function doctorFinalCut(args: string[]): Promise<void> {
  if (args[0] !== "finalcut") throw new Error("Usage: framekit doctor finalcut [--json]");
  const status = await new FinalCutConnectionManager().ensureConnected();
  printStatus(status, args.includes("--json"));
  if (status.state !== "ready") process.exitCode = 1;
}

export async function runMcp(args: string[], dependencies: McpStartupDependencies = {}): Promise<void> {
  const editorIndex = args.indexOf("--editor");
  const editor = editorIndex >= 0 ? args[editorIndex + 1] : "final-cut-live";
  const headless = args.includes("--headless");
  const development = args.includes("--development");
  if (editor !== "final-cut-live" && editor !== "fixture") {
    throw new Error("Usage: framekit mcp [--editor final-cut-live|fixture] [--headless] [--development]");
  }
  if (headless && editor !== "final-cut-live") {
    throw new Error("Usage: --headless is only supported with --editor final-cut-live");
  }
  if (development && editor !== "final-cut-live") {
    throw new Error("Usage: --development is only supported with --editor final-cut-live");
  }
  if (development) {
    const connect = dependencies.connectDevelopmentExtension ?? connectFinalCut;
    const status = await connect(["finalcut", "--development", "--json"], dependencies.stderr ?? process.stderr);
    if (status.state !== "ready") return;
  }
  const root = repoRoot();
  const compiled = fileURLToPath(import.meta.url).endsWith(".js");
  const entrypoint = join(root, `apps/mcp-server/src/main.${compiled ? "js" : "ts"}`);
  const child = (dependencies.spawnChild ?? spawn)(process.execPath, [...(compiled ? [] : ["--import", "tsx"]), entrypoint], {
    stdio: "inherit",
    env: {
      ...process.env,
      FRAMEKIT_EDITOR: editor,
      ...(development ? { FRAMEKIT_REQUIRE_BUILD_ALIGNMENT: "1" } : {}),
      ...(headless
        ? {
            FRAMEKIT_FINAL_CUT_HEADLESS: "1",
            FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0",
            FRAMEKIT_AUTO_CONNECT: "1",
          }
        : {}),
    },
  });
  await new Promise<void>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      process.exitCode = code ?? (signal ? 1 : 0);
      resolvePromise();
    });
  });
}

async function buildDevelopmentExtension(): Promise<void> {
  const buildScript = join(repoRoot(), "adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/build.sh");
  await access(buildScript);
  await execFile("bash", [buildScript], { cwd: repoRoot(), maxBuffer: 10 * 1024 * 1024 });
}

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../..");
}

function printStatus(
  status: ReturnType<FinalCutConnectionManager["getStatus"]>,
  json: boolean,
  output: StatusOutput = process.stdout,
): void {
  if (json) {
    output.write(`${JSON.stringify(status)}\n`);
    return;
  }
  output.write(`Framekit Final Cut: ${status.state}\n`);
  output.write(`Final Cut detected: ${status.editorDetected ? "yes" : "no"}\n`);
  output.write(`Extension: ${status.extensionInstalled ? status.extensionPath : "not installed"}\n`);
  output.write(`Socket: ${status.socketPath}\n`);
  if (status.identity) output.write(`Editor: ${status.identity.name} (${status.identity.backend})\n`);
  if (status.lastError) output.write(`Reason: ${status.lastError.code}: ${status.lastError.message}\n`);
}

function printHelp(): void {
  process.stdout.write([
    "Framekit local editor connection",
    "",
    "  framekit connect finalcut [--development] [--json]",
    "  framekit doctor finalcut [--json]",
    "  framekit mcp --editor final-cut-live [--headless] [--development]",
    "",
    "Codex registration:",
    "  codex mcp add framekit -- framekit mcp --editor final-cut-live --headless",
    "",
  ].join("\n"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch((error) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
