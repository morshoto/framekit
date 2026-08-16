import { execFile as execFileCallback, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { FinalCutConnectionManager } from "@framekit/final-cut";

const execFile = promisify(execFileCallback);

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

async function connectFinalCut(args: string[]): Promise<void> {
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
  const manager = new FinalCutConnectionManager({ extensionSourcePath });
  const status = await manager.ensureConnected();
  printStatus(status, json);
  if (status.state !== "ready") process.exitCode = 1;
}

async function doctorFinalCut(args: string[]): Promise<void> {
  if (args[0] !== "finalcut") throw new Error("Usage: framekit doctor finalcut [--json]");
  const status = await new FinalCutConnectionManager().ensureConnected();
  printStatus(status, args.includes("--json"));
  if (status.state !== "ready") process.exitCode = 1;
}

async function runMcp(args: string[]): Promise<void> {
  const editorIndex = args.indexOf("--editor");
  const editor = editorIndex >= 0 ? args[editorIndex + 1] : "final-cut-live";
  if (editor !== "final-cut-live" && editor !== "fixture") {
    throw new Error("Usage: framekit mcp [--editor final-cut-live|fixture]");
  }
  const root = repoRoot();
  const entrypoint = join(root, "apps/mcp-server/src/main.ts");
  const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
    stdio: "inherit",
    env: { ...process.env, FRAMEKIT_EDITOR: editor },
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

function printStatus(status: ReturnType<FinalCutConnectionManager["getStatus"]>, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(status)}\n`);
    return;
  }
  process.stdout.write(`Framekit Final Cut: ${status.state}\n`);
  process.stdout.write(`Final Cut detected: ${status.editorDetected ? "yes" : "no"}\n`);
  process.stdout.write(`Extension: ${status.extensionInstalled ? status.extensionPath : "not installed"}\n`);
  process.stdout.write(`Socket: ${status.socketPath}\n`);
  if (status.identity) process.stdout.write(`Editor: ${status.identity.name} (${status.identity.backend})\n`);
  if (status.lastError) process.stdout.write(`Reason: ${status.lastError.code}: ${status.lastError.message}\n`);
}

function printHelp(): void {
  process.stdout.write([
    "Framekit local editor connection",
    "",
    "  framekit connect finalcut [--development] [--json]",
    "  framekit doctor finalcut [--json]",
    "  framekit mcp --editor final-cut-live",
    "",
    "Codex registration:",
    "  codex mcp add framekit -- framekit mcp --editor final-cut-live",
    "",
  ].join("\n"));
}

void main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
