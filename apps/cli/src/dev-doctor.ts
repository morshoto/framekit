import { execFile as execFileCallback } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type DevDoctorProfile = "fixture" | "headless" | "native";
export type DevDoctorStatus = "pass" | "fail" | "unavailable";

export interface DevDoctorCheck {
  name: string;
  requirement: "required" | "optional";
  status: DevDoctorStatus;
  message: string;
  path?: string;
}

export interface DevDoctorReport {
  profile: DevDoctorProfile;
  ready: boolean;
  checks: DevDoctorCheck[];
}

export interface CollectDevDoctorOptions {
  profile: DevDoctorProfile;
  rootDirectory: string;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  runCommand?: (command: string, args: string[]) => Promise<string>;
  isPathWritable?: (path: string) => Promise<boolean>;
}

interface ToolchainPins {
  node: string;
  pnpm: string;
}

const tools = [
  { name: "FFmpeg", command: "ffmpeg", args: ["-version"], install: "ffmpeg" },
  { name: "ffprobe", command: "ffprobe", args: ["-version"], install: "ffmpeg" },
  { name: "SQLite", command: "sqlite3", args: ["--version"], install: "sqlite" },
] as const;

export async function collectDevDoctorReport(options: CollectDevDoctorOptions): Promise<DevDoctorReport> {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? environment.HOME ?? homedir();
  const runCommand = options.runCommand ?? defaultRunCommand;
  const isPathWritable = options.isPathWritable ?? defaultIsPathWritable;
  const platform = options.platform ?? process.platform;
  const pins = await readToolchainPins(options.rootDirectory);
  const checks: DevDoctorCheck[] = [];

  if (!pins.node) {
    checks.push({
      name: "Node.js",
      requirement: "required",
      status: "fail",
      message: "The repository .node-version pin is missing or invalid.",
    });
  } else {
    const currentNode = options.nodeVersion ?? process.version;
    const supported = versionAtLeast(currentNode, pins.node);
    checks.push({
      name: "Node.js",
      requirement: "required",
      status: supported ? "pass" : "fail",
      message: supported
        ? `Node.js ${currentNode.replace(/^v/, "")} meets the ${pins.node} contributor minimum.`
        : `Node.js ${pins.node} or newer is required; found ${currentNode}. Use nix develop ./nix or install the contributor toolchain.`,
    });
  }

  if (!pins.pnpm) {
    checks.push({
      name: "pnpm",
      requirement: "required",
      status: "fail",
      message: "package.json must pin an exact pnpm version in packageManager.",
    });
  } else {
    try {
      const actual = (await runCommand("pnpm", ["--version"])).trim();
      const matches = actual === pins.pnpm;
      checks.push({
        name: "pnpm",
        requirement: "required",
        status: matches ? "pass" : "fail",
        message: matches
          ? `pnpm ${actual} matches the repository pin.`
          : `pnpm ${pins.pnpm} is required; found ${actual || "an unknown version"}. Run pnpm through Corepack inside nix develop ./nix.`,
      });
    } catch {
      checks.push({
        name: "pnpm",
        requirement: "required",
        status: "fail",
        message: `pnpm ${pins.pnpm} is required; it was not available. Run pnpm through Corepack inside nix develop ./nix.`,
      });
    }
  }

  const statePath = resolve(environment.FRAMEKIT_STATE_DIR ?? join(homeDirectory, ".framekit"));
  const cachePath = resolve(
    environment.XDG_CACHE_HOME
      ?? environment.npm_config_cache
      ?? environment.NPM_CONFIG_CACHE
      ?? join(homeDirectory, ".cache"),
  );
  for (const [name, path] of [["State directory", statePath], ["Cache directory", cachePath]] as const) {
    const writable = await isPathWritable(path);
    checks.push({
      name,
      requirement: "required",
      status: writable ? "pass" : "fail",
      path,
      message: writable
        ? `${path} is writable or can be created under a writable parent.`
        : `${path} is not writable. Choose a writable path with ${name === "State directory" ? "FRAMEKIT_STATE_DIR" : "XDG_CACHE_HOME"}.`,
    });
  }

  const requiredTools = options.profile === "fixture" ? new Set<string>() : new Set(["ffmpeg", "ffprobe", "sqlite3"]);
  for (const tool of tools) {
    const requirement = requiredTools.has(tool.command) ? "required" : "optional";
    try {
      await runCommand(tool.command, [...tool.args]);
      checks.push({
        name: tool.name,
        requirement,
        status: "pass",
        message: `${tool.command} is available.`,
      });
    } catch {
      checks.push({
        name: tool.name,
        requirement,
        status: requirement === "required" ? "fail" : "unavailable",
        message: requirement === "required"
          ? `${tool.command} is required for the ${options.profile} profile. Install ${tool.install} with nix develop ./nix.`
          : `${tool.command} is unavailable; the fixture profile does not require it.`,
      });
    }
  }

  if (options.profile === "native") {
    if (platform !== "darwin") {
      checks.push({
        name: "Xcode",
        requirement: "required",
        status: "fail",
        message: "The native profile requires macOS with Xcode selected; fixture and headless profiles do not.",
      });
    } else {
      try {
        await runCommand("xcodebuild", ["-version"]);
        checks.push({
          name: "Xcode",
          requirement: "required",
          status: "pass",
          message: "xcodebuild is available.",
        });
      } catch {
        checks.push({
          name: "Xcode",
          requirement: "required",
          status: "fail",
          message: "The native profile requires Xcode selected with xcode-select.",
        });
      }
    }
  }

  return {
    profile: options.profile,
    ready: checks.every((check) => check.requirement !== "required" || check.status === "pass"),
    checks,
  };
}

async function readToolchainPins(rootDirectory: string): Promise<ToolchainPins> {
  try {
    const [node, packageJson] = await Promise.all([
      readFile(join(rootDirectory, ".node-version"), "utf8"),
      readFile(join(rootDirectory, "package.json"), "utf8"),
    ]);
    const packageManager = (JSON.parse(packageJson) as { packageManager?: unknown }).packageManager;
    return {
      node: /^\d+\.\d+\.\d+$/.test(node.trim()) ? node.trim() : "",
      pnpm: typeof packageManager === "string" ? packageManager.match(/^pnpm@(\d+\.\d+\.\d+)$/)?.[1] ?? "" : "",
    };
  } catch {
    return { node: "", pnpm: "" };
  }
}

function versionAtLeast(actualVersion: string, minimumVersion: string): boolean {
  const actual = actualVersion.replace(/^v/, "").split(".").map(Number);
  const minimum = minimumVersion.split(".").map(Number);
  if (actual.length < 3 || actual.some((part) => !Number.isInteger(part)) || minimum.length < 3) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

async function defaultRunCommand(command: string, args: string[]): Promise<string> {
  const result = await execFile(command, args, { timeout: 5_000, maxBuffer: 1024 * 1024 });
  return result.stdout;
}

async function defaultIsPathWritable(path: string): Promise<boolean> {
  let candidate = path;
  while (true) {
    try {
      const information = await stat(candidate);
      if (!information.isDirectory()) return false;
      await access(candidate, 3); // W_OK | X_OK: writable and searchable directory.
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      const parent = dirname(candidate);
      if (parent === candidate) return false;
      candidate = parent;
    }
  }
}
