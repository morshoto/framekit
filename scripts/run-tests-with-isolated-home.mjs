import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareTestInventory,
  discoverTestFiles,
  evaluateSuitePrerequisites,
  loadTestSuiteManifest,
  selectTestFiles,
} from "./test-suites.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const suiteName = process.argv[2] ?? "all";
const manifest = await loadTestSuiteManifest(repositoryRoot);
const discoveredFiles = await discoverTestFiles(repositoryRoot);
const inventory = compareTestInventory(manifest.tests.map(({ path: file }) => file), discoveredFiles);
if (inventory.missing.length || inventory.unregistered.length) {
  process.stderr.write([
    "TEST_INVENTORY_DRIFT: aggregate collection differs from the reviewed inventory.",
    `Missing: ${inventory.missing.join(", ") || "none"}`,
    `Unregistered: ${inventory.unregistered.join(", ") || "none"}`,
    "Review tags and update it with `pnpm run test:inventory:update`.",
    "",
  ].join("\n"));
  process.exit(1);
}
const prerequisites = evaluateSuitePrerequisites(suiteName, {
  availableExecutables: new Set(["node", ...["ffmpeg", "ffprobe", "npm"].filter(executableAvailable)]),
  manifest,
  nodeVersion: process.versions.node,
});
if (!prerequisites.ready) {
  process.stderr.write(`TEST_SUITE_BLOCKED: ${suiteName} requires ${prerequisites.missing.join(" and ")}; install the listed toolchain and retry.\n`);
  process.exit(2);
}
if (process.argv.includes("--check-only")) {
  process.stdout.write(`TEST_SUITE_PREREQUISITES_READY: ${suiteName}\n`);
  process.exit(0);
}
const testFiles = selectTestFiles(manifest, suiteName);
process.stdout.write(`TEST_SUITE_SELECTED: ${suiteName} (${testFiles.length} files)\n`);
const originalHome = process.env.HOME ?? os.homedir();
const temporaryRoot = process.platform === "win32" ? os.tmpdir() : "/tmp";
if (isWithin(originalHome, temporaryRoot)) {
  throw new Error("TEST_TEMP_DIRECTORY_INSIDE_CONTRIBUTOR_HOME");
}
const stateRoot = await mkdtemp(path.join(temporaryRoot, "framekit-test-run-"));
const isolatedHome = path.join(stateRoot, "home");
const isolatedBin = path.join(stateRoot, "bin");
const writableDirectories = {
  framekit: path.join(stateRoot, "framekit-state"),
  temporary: path.join(stateRoot, "tmp"),
  npmCache: path.join(stateRoot, "npm-cache"),
  config: path.join(stateRoot, "config"),
  cache: path.join(stateRoot, "cache"),
  data: path.join(stateRoot, "data"),
  state: path.join(stateRoot, "xdg-state"),
  runtime: path.join(stateRoot, "runtime"),
};

await Promise.all([
  mkdir(isolatedHome),
  mkdir(isolatedBin),
  ...Object.values(writableDirectories).map((directory) => mkdir(directory, { recursive: true })),
]);
const packageManagerPath = process.env.npm_execpath;
let isolatedPnpmPath;
if (packageManagerPath) {
  isolatedPnpmPath = process.platform === "win32"
    ? path.join(isolatedBin, "pnpm.cmd")
    : path.join(isolatedBin, "pnpm");
  if (process.platform === "win32") {
    await writeFile(isolatedPnpmPath, `@echo off\r\n"${process.execPath}" "${packageManagerPath}" %*\r\n`);
  } else {
    await symlink(packageManagerPath, isolatedPnpmPath);
  }
}
await chmod(writableDirectories.runtime, 0o700);
await chmod(isolatedHome, 0o555);

const environment = {
  ...process.env,
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  TMPDIR: writableDirectories.temporary,
  TMP: writableDirectories.temporary,
  TEMP: writableDirectories.temporary,
  XDG_CONFIG_HOME: writableDirectories.config,
  XDG_CACHE_HOME: writableDirectories.cache,
  XDG_DATA_HOME: writableDirectories.data,
  XDG_STATE_HOME: writableDirectories.state,
  XDG_RUNTIME_DIR: writableDirectories.runtime,
  npm_config_cache: writableDirectories.npmCache,
  FRAMEKIT_STATE_DIR: writableDirectories.framekit,
  FRAMEKIT_TEST_STATE_DIR: stateRoot,
  FRAMEKIT_TEST_ORIGINAL_HOME: originalHome,
  FRAMEKIT_COMMIT_VALIDATION: "1",
  PATH: [isolatedPnpmPath ? isolatedBin : undefined, process.env.PATH]
    .filter((entry) => Boolean(entry))
    .join(path.delimiter),
};

try {
  if (suiteName === "all") {
    let documentationTestFiles = [];
    try {
      documentationTestFiles = (await readdir(path.join(repositoryRoot, "tests/documentation")))
        .filter((file) => file.endsWith(".test.mjs"))
        .map((file) => path.join("tests/documentation", file));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (documentationTestFiles.length > 0) {
      const documentationExitCode = await runCommand(process.execPath, ["--test", ...documentationTestFiles], environment);
      if (documentationExitCode !== 0) {
        process.exitCode = documentationExitCode;
        process.exit(documentationExitCode);
      }
    }
  }
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--test", ...testFiles], {
      cwd: repositoryRoot,
      env: environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
} finally {
  await chmod(isolatedHome, 0o700).catch(() => undefined);
  await rm(stateRoot, { recursive: true, force: true });
}

function executableAvailable(executable) {
  const lookup = process.platform === "win32" ? "where" : "which";
  return spawnSync(lookup, [executable], { stdio: "ignore" }).status === 0;
}

function runCommand(command, args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repositoryRoot, env: environment, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

function isWithin(parent, candidate) {
  const relativePath = path.relative(path.resolve(parent), path.resolve(candidate));
  return relativePath === ""
    || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath));
}
