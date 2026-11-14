import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import { prepareTestReport, writeTestSummary } from "./ci/test-reports.mjs";
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
let selection;
try { selection = parseArguments(process.argv.slice(2)); }
catch (error) { process.stderr.write(`${error.message}\n`); process.exit(64); }
if (selection.help) {
  process.stdout.write('Usage: pnpm test [suite] [--file path.test.ts|path.test.mjs] [--test-name-pattern regex] [--watch] [--check-only]\n');
  process.exit(0);
}
const suiteName = selection.suite;
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
const suiteFiles = selectTestFiles(manifest, suiteName);
for (const file of selection.files) {
  if (!suiteFiles.includes(file)) { process.stderr.write(`TEST_FILE_UNKNOWN: ${file} is outside the reviewed ${suiteName} suite\n`); process.exit(64); }
}
const testFiles = selection.files.length ? [...new Set(selection.files)].sort() : suiteFiles;
if (!testFiles.length) { process.stderr.write('TEST_SELECTION_EMPTY\n'); process.exit(64); }
const prerequisites = evaluateSuitePrerequisites(suiteName, {
  availableExecutables: new Set(["node", ...[...new Set(manifest.tests.filter(entry => testFiles.includes(entry.path)).flatMap(entry => [...entry.requires, ...(entry.conditionalRequires ?? []).filter(rule => rule.platform === process.platform).flatMap(rule => rule.executables)]))].filter(executableAvailable)]),
  manifest,
  selectedFiles: testFiles,
  offline: process.env.FRAMEKIT_TEST_OFFLINE === "1",
  nodeVersion: process.versions.node,
});
if (!prerequisites.ready) {
  process.stderr.write(`TEST_SUITE_BLOCKED: ${suiteName} requires ${prerequisites.missing.join(" and ")}; install the listed toolchain and retry.\n`);
  process.exit(2);
}
if (selection.checkOnly) {
  process.stdout.write(`TEST_SUITE_PREREQUISITES_READY: ${suiteName}\n`);
  process.exit(0);
}
process.stdout.write(`TEST_SUITE_SELECTED: ${suiteName} (${testFiles.length} files)\n`);
let reportDirectory = process.env.FRAMEKIT_TEST_REPORT_DIR ? path.resolve(process.env.FRAMEKIT_TEST_REPORT_DIR) : undefined;
const testedSha = reportDirectory ? spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim() : undefined;
const originalHome = process.env.HOME ?? os.homedir();
const temporaryRoot = process.platform === "win32" ? os.tmpdir() : "/tmp";
if (isWithin(originalHome, temporaryRoot)) {
  throw new Error("TEST_TEMP_DIRECTORY_INSIDE_CONTRIBUTOR_HOME");
}
const stateRoot = await mkdtemp(path.join(temporaryRoot, "framekit-test-run-"));
reportDirectory ??= path.join(stateRoot, "reports");
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
  FRAMEKIT_EDITOR: "fixture",
  FRAMEKIT_FINAL_CUT_HEADLESS: "1",
  FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0",
  FRAMEKIT_AUTO_CONNECT: "0",
  FRAMEKIT_FINAL_CUT_LIBRARY_HEADED: "0",
  PATH: [isolatedPnpmPath ? isolatedBin : undefined, process.env.PATH]
    .filter((entry) => Boolean(entry))
    .join(path.delimiter),
};

try {
  const flags = [selection.watch ? '--watch' : undefined,
    ...(selection.pattern === undefined ? [] : ['--test-name-pattern', selection.pattern])].filter(Boolean);
  const exitCode = await runCommand(process.execPath, ["--import", "tsx", "--test", ...flags, ...testFiles], environment);
  process.exitCode = exitCode;
  if (selection.pattern !== undefined && !selection.watch && exitCode === 0) {
    const summary = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(reportDirectory, `${suiteName}.json`), 'utf8'));
    if (!summary.matchedTests) { process.stderr.write('TEST_NAME_NO_MATCH: no tests matched the name filter\n'); process.exitCode = 1; }
  }
} finally {
  try {
    if (reportDirectory) await writeTestSummary(reportDirectory, process.env.GITHUB_STEP_SUMMARY);
  } finally {
    await chmod(isolatedHome, 0o700).catch(() => undefined);
    await rm(stateRoot, { recursive: true, force: true });
  }
}

function executableAvailable(executable) {
  const lookup = process.platform === "win32" ? "where" : "which";
  return spawnSync(lookup, [executable], { stdio: "ignore" }).status === 0;
}

async function runCommand(command, args, environment) {
  if (reportDirectory) {
    const phase = args.includes("--import") ? suiteName : "documentation";
    const reporters = await prepareTestReport(reportDirectory, phase, {
      suite: suiteName, testedSha,
      skipPolicy: manifest.tests.filter(entry => testFiles.includes(entry.path)).flatMap(entry =>
        (entry.expectedSkips ?? []).map(rule => ({ ...rule, file: entry.path }))),
      candidateSha: process.env.FRAMEKIT_HEADLESS_RELEASE_GATE_CANDIDATE_SHA,
      selectedFiles: args.filter(argument => /\.test\.(?:ts|mjs)$/.test(argument)),
    });
    args = [...reporters, ...args];
  }
  return new Promise((resolve, reject) => {
    // The runner owns reporter destinations, including under the commit hook's
    // NODE_OPTIONS reporter. Preserve all unrelated Node options.
    const childEnvironment = { ...environment, NODE_OPTIONS: (environment.NODE_OPTIONS ?? '').replace(/--test-reporter(?:-destination)?=(?:"[^"]*"|'[^']*'|\S+)/g, '').trim() };
    const child = spawn(command, args, { cwd: repositoryRoot, env: childEnvironment, stdio: "inherit" });
    const forward = signal => child.kill(signal);
    const interrupt = () => forward('SIGINT');
    const terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", (code) => { cleanup(); resolve(code ?? 1); });
  });
}

function isWithin(parent, candidate) {
  const relativePath = path.relative(path.resolve(parent), path.resolve(candidate));
  return relativePath === ""
    || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath));
}

function parseArguments(args) {
  const result = { suite: 'all', files: [], watch: false, checkOnly: false };
  let suiteSeen = false;
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === '--') continue;
    if (argument === '--watch') result.watch = true;
    else if (argument === '--check-only') result.checkOnly = true;
    else if (argument === '--help' || argument === '-h') result.help = true;
    else if (argument === '--file' || argument === '--test-name-pattern' || argument.startsWith('--test-name-pattern=')) {
      const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : args[++i];
      if (!value || value.startsWith('--')) throw new Error(`TEST_ARGUMENT: ${argument} requires a value`);
      if (argument === '--file') result.files.push(value.replace(/^\.\//, ''));
      else { try { new RegExp(value); } catch { throw new Error('TEST_ARGUMENT: invalid test-name pattern'); } result.pattern = value; }
    } else if (argument.startsWith('-')) throw new Error(`TEST_ARGUMENT: unknown option ${argument}`);
    else if (/\.test\.(ts|mjs)$/.test(argument)) result.files.push(argument.replace(/^\.\//, ''));
    else if (!suiteSeen) { result.suite = argument; suiteSeen = true; }
    else throw new Error(`TEST_ARGUMENT: unexpected argument ${argument}`);
  }
  if (result.watch && result.checkOnly) throw new Error('TEST_ARGUMENT: --watch and --check-only cannot be combined');
  return result;
}
