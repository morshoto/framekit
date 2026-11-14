import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifestPath = "scripts/test-suite-manifest.json";
const excludedDirectories = new Set([".git", ".codex", "coverage", "dist", "dist-package", "node_modules"]);
export const TEST_SUITE_DEFINITIONS = Object.freeze({
  documentation: { tags: ["documentation"], executables: [] },
  all: { tags: [], executables: ["ffmpeg", "ffprobe", "npm"] },
  fast: {
    tags: ["unit", "contract", "fast-integration"],
    exclude: ["tests/integration/finalcut-mcp.test.ts", "tests/integration/headless-project-mcp.test.ts"],
    executables: [],
  },
  unit: { tags: ["unit"], executables: [] },
  contract: { tags: ["contract"], executables: [] },
  fixture: { tags: ["fixture-e2e"], executables: ["ffmpeg", "ffprobe", "npm"] },
  integration: { tags: ["integration"], executables: ["ffmpeg", "ffprobe", "npm"] },
  headless: { tags: ["headless"], executables: ["ffmpeg", "ffprobe"] },
  native: { tags: ["native"], executables: [] },
  package: { tags: ["package"], executables: ["npm"] },
  "release-gate": { tags: ["release-gate"], executables: ["ffmpeg", "ffprobe"] },
});

export async function discoverTestFiles(rootDir = repositoryRoot) {
  const files = [];
  for (const root of ["tests", "packages", "apps", "adapters"]) {
    await walk(resolve(rootDir, root), rootDir, files);
  }
  return files.sort();
}

export async function loadTestSuiteManifest(rootDir = repositoryRoot) {
  const manifest = JSON.parse(await readFile(resolve(rootDir, manifestPath), "utf8"));
  if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.tests)) {
    throw new Error("TEST_SUITE_MANIFEST_INVALID: expected schemaVersion 2 and a tests array");
  }
  const paths = new Set();
  for (const entry of manifest.tests) {
    if (!entry.reviewed) throw new Error(`TEST_METADATA_UNREVIEWED: ${entry.path}; review owner, evidence, dependencies and requirements`);
    if (paths.has(entry.path) || !entry.owner || entry.owner === 'shared'
      || !['unit', 'fixture', 'process', 'static', 'sdk'].includes(entry.evidence)
      || !['none', 'registry'].includes(entry.network)
      || !Array.isArray(entry.tags) || !entry.tags.length
      || !Array.isArray(entry.requires) || !Array.isArray(entry.dependsOn) || !entry.dependsOn.length
      || !Array.isArray(entry.platforms) || !entry.platforms.length
      || entry.platforms.some(platform => !['any', 'darwin', 'linux', 'win32'].includes(platform))) {
      throw new Error(`TEST_METADATA_INVALID: ${entry.path}`);
    }
    paths.add(entry.path);
  }
  return manifest;
}

export function compareTestInventory(expectedFiles, discoveredFiles) {
  const expected = new Set(expectedFiles);
  const discovered = new Set(discoveredFiles);
  return {
    missing: [...expected].filter((file) => !discovered.has(file)).sort(),
    unregistered: [...discovered].filter((file) => !expected.has(file)).sort(),
  };
}

export function selectTestFiles(manifest, suiteName) {
  const definition = TEST_SUITE_DEFINITIONS[suiteName];
  if (!definition) throw new Error(`TEST_SUITE_UNKNOWN: ${suiteName}`);
  if (suiteName === "all") return manifest.tests.map(({ path }) => path).sort();
  const tags = new Set(definition.tags);
  return manifest.tests
    .filter((entry) => !definition.exclude?.includes(entry.path) && entry.tags.some((tag) => tags.has(tag)))
    .map(({ path }) => path)
    .sort();
}

export function evaluateSuitePrerequisites(suiteName, options = {}) {
  const definition = TEST_SUITE_DEFINITIONS[suiteName];
  if (!definition) throw new Error(`TEST_SUITE_UNKNOWN: ${suiteName}`);
  const available = options.availableExecutables ?? new Set();
  const selectedPaths = new Set(options.selectedFiles ?? (options.manifest ? selectTestFiles(options.manifest, suiteName) : []));
  const selected = options.manifest ? options.manifest.tests.filter((entry) => selectedPaths.has(entry.path)) : [];
  const executables = new Set([
    ...(options.manifest ? [] : definition.executables),
    ...selected.flatMap((entry) => entry.requires ?? []),
  ]);
  const nodeMajor = Number.parseInt((options.nodeVersion ?? process.versions.node).split(".")[0] ?? "0", 10);
  const missing = [...executables].filter((executable) => !available.has(executable));
  for (const entry of selected) {
    const platform = options.platform ?? process.platform;
    if (!entry.platforms.includes('any') && !entry.platforms.includes(platform)) missing.push(`platform ${entry.platforms.join('/')} for ${entry.path} (current ${platform})`);
    if (options.offline && entry.network !== 'none') missing.push(`network ${entry.network} for ${entry.path}`);
  }
  if (!Number.isFinite(nodeMajor) || nodeMajor < 20) missing.unshift("Node.js 20 or newer");
  return {
    ready: missing.length === 0,
    missing,
  };
}

export async function updateTestSuiteManifest(rootDir = repositoryRoot) {
  let previous = { tests: [] };
  try { previous = JSON.parse(await readFile(resolve(rootDir, manifestPath), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const byPath = new Map(previous.tests.map(entry => [entry.path, entry]));
  const tests = (await discoverTestFiles(rootDir)).map(path => byPath.get(path) ?? {
    path, owner: 'unreviewed', reviewed: false, tags: tagsForTest(path),
    evidence: 'fixture', dependsOn: [], requires: [], platforms: ['any'], network: 'none',
  });
  const manifest = { ...previous, schemaVersion: 2, tests };
  await writeFile(resolve(rootDir, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv.includes("--update-inventory")) {
  const manifest = await updateTestSuiteManifest();
  process.stdout.write(`Updated test inventory for ${manifest.tests.length} files.\n`);
}

async function walk(directory, rootDir, files) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (relative(rootDir, join(directory, entry.name)).split(sep).join("/") === "apps/docs" || relative(rootDir, join(directory, entry.name)).split(sep).join("/") === "tests/research") continue;
    if (entry.isDirectory() && !excludedDirectories.has(entry.name)) {
      await walk(join(directory, entry.name), rootDir, files);
    } else if (entry.isFile() && (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.mjs"))) {
      files.push(relative(rootDir, join(directory, entry.name)).split(sep).join("/"));
    }
  }
}

function tagsForTest() {
  // New tests require a human review. Folder names do not establish evidence.
  return ['unreviewed'];
}
