import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectDevDoctorReport } from "../../apps/cli/src/dev-doctor.js";

const repositoryRoot = new URL("../../", import.meta.url).pathname;
const homeDirectory = join(tmpdir(), "framekit-dev-doctor-home");

function checkNamed(report: Awaited<ReturnType<typeof collectDevDoctorReport>>, name: string) {
  const check = report.checks.find((entry) => entry.name === name);
  assert.ok(check, `expected a ${name} diagnostic`);
  return check;
}

test("fixture doctor checks contributor tools and writable paths without native requirements", async () => {
  const commands: string[] = [];
  const checkedPaths: string[] = [];
  const report = await collectDevDoctorReport({
    profile: "fixture",
    rootDirectory: repositoryRoot,
    environment: {
      HOME: homeDirectory,
      FRAMEKIT_STATE_DIR: join(homeDirectory, ".framekit-state"),
      XDG_CACHE_HOME: join(homeDirectory, ".cache"),
    },
    homeDirectory,
    nodeVersion: "v22.14.0",
    platform: "linux",
    runCommand: async (command) => {
      commands.push(command);
      if (command === "pnpm") return "12.14.0";
      throw new Error("not installed");
    },
    isPathWritable: async (path) => {
      checkedPaths.push(path);
      return true;
    },
  });

  assert.equal(report.profile, "fixture");
  assert.equal(report.ready, true);
  assert.equal(checkNamed(report, "Node.js").status, "pass");
  assert.equal(checkNamed(report, "pnpm").status, "pass");
  assert.equal(checkNamed(report, "FFmpeg").requirement, "optional");
  assert.equal(checkNamed(report, "ffprobe").requirement, "optional");
  assert.equal(checkNamed(report, "SQLite").requirement, "optional");
  assert.deepEqual(checkedPaths, [
    join(homeDirectory, ".framekit-state"),
    join(homeDirectory, ".cache"),
  ]);
  assert.ok(!commands.includes("xcodebuild"));
  assert.ok(!commands.includes("Final Cut Pro"));
});

test("headless doctor reports missing render prerequisites with actionable messages", async () => {
  const commands: string[] = [];
  const report = await collectDevDoctorReport({
    profile: "headless",
    rootDirectory: repositoryRoot,
    environment: { HOME: homeDirectory },
    homeDirectory,
    nodeVersion: "v22.14.0",
    platform: "linux",
    runCommand: async (command) => {
      commands.push(command);
      if (command === "pnpm") return "12.14.0";
      if (command === "ffprobe") return "ffprobe version 7.1";
      throw new Error("not installed");
    },
    isPathWritable: async () => true,
  });

  assert.equal(report.ready, false);
  assert.equal(checkNamed(report, "FFmpeg").status, "fail");
  assert.match(checkNamed(report, "FFmpeg").message, /install|nix develop/i);
  assert.equal(checkNamed(report, "ffprobe").status, "pass");
  assert.equal(checkNamed(report, "SQLite").status, "fail");
  assert.ok(commands.includes("ffmpeg"));
  assert.ok(commands.includes("sqlite3"));
});

test("doctor reports unwritable state and cache paths with override guidance", async () => {
  const report = await collectDevDoctorReport({
    profile: "fixture",
    rootDirectory: repositoryRoot,
    environment: { HOME: homeDirectory },
    homeDirectory,
    nodeVersion: "v22.14.0",
    runCommand: async (command) => {
      if (command === "pnpm") return "12.14.0";
      throw new Error("not installed");
    },
    isPathWritable: async () => false,
  });

  assert.equal(report.ready, false);
  assert.match(checkNamed(report, "State directory").message, /FRAMEKIT_STATE_DIR/);
  assert.match(checkNamed(report, "Cache directory").message, /XDG_CACHE_HOME/);
});

test("doctor checks missing state and cache paths without creating them", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "framekit-doctor-paths-"));
  const statePath = join(temporaryDirectory, "future-state");
  const cachePath = join(temporaryDirectory, "future-cache");
  try {
    const report = await collectDevDoctorReport({
      profile: "fixture",
      rootDirectory: repositoryRoot,
      environment: { HOME: temporaryDirectory, FRAMEKIT_STATE_DIR: statePath, XDG_CACHE_HOME: cachePath },
      homeDirectory: temporaryDirectory,
      nodeVersion: "v22.14.0",
      runCommand: async (command) => {
        if (command === "pnpm") return "12.14.0";
        throw new Error("not installed");
      },
    });

    assert.equal(report.ready, true);
    assert.deepEqual(await readdir(temporaryDirectory), []);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("native doctor checks Xcode only for the native profile", async () => {
  const commands: string[] = [];
  const report = await collectDevDoctorReport({
    profile: "native",
    rootDirectory: repositoryRoot,
    environment: { HOME: homeDirectory },
    homeDirectory,
    nodeVersion: "v22.14.0",
    platform: "darwin",
    runCommand: async (command) => {
      commands.push(command);
      if (command === "pnpm") return "12.14.0";
      if (command === "ffmpeg" || command === "ffprobe" || command === "sqlite3" || command === "xcodebuild") return "available";
      throw new Error("not installed");
    },
    isPathWritable: async () => true,
  });

  assert.equal(report.ready, true);
  assert.equal(checkNamed(report, "Xcode").status, "pass");
  assert.ok(commands.includes("xcodebuild"));
});

test("CLI exposes fixture doctor JSON without requiring native tools", () => {
  const result = spawnSync(process.execPath, [
    "--import", "tsx",
    "apps/cli/src/main.ts",
    "doctor", "dev", "--profile", "fixture", "--json",
  ], {
    cwd: repositoryRoot,
    env: process.env,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as Awaited<ReturnType<typeof collectDevDoctorReport>>;
  assert.equal(report.profile, "fixture");
  assert.equal(report.ready, true);
  assert.equal(checkNamed(report, "Node.js").status, "pass");
  assert.equal(checkNamed(report, "pnpm").status, "pass");
  assert.ok(!report.checks.some((check) => check.name === "Xcode"));
});

test("CI exercises the Linux Nix fixture bootstrap and stdio smoke", async () => {
  const [workflow, nixReadme, packageJsonText] = await Promise.all([
    readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8"),
    readFile(join(repositoryRoot, "nix/README.md"), "utf8"),
    readFile(join(repositoryRoot, "package.json"), "utf8"),
  ]);
  const packageJson = JSON.parse(packageJsonText) as { scripts?: Record<string, string> };

  assert.match(workflow, /Linux Nix fixture bootstrap/);
  assert.match(workflow, /nix develop \.\/nix/);
  assert.match(workflow, /doctor dev --profile fixture/);
  assert.match(workflow, /pnpm run test:fixtures/);
  assert.match(workflow, /pnpm run smoke:fixture-mcp/);
  assert.equal(packageJson.scripts?.["smoke:fixture-mcp"], "node scripts/fixture-mcp-smoke.mjs");
  assert.match(nixReadme, /pnpm install --frozen-lockfile/);
  assert.match(nixReadme, /pnpm run test:fixtures/);
  assert.match(nixReadme, /pnpm run smoke:fixture-mcp/);
});
