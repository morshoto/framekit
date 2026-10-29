import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifestPath = "scripts/test-suite-manifest.json";
const excludedDirectories = new Set([".git", "coverage", "dist", "node_modules"]);

export const TEST_SUITE_DEFINITIONS = Object.freeze({
  all: { tags: [], executables: ["ffmpeg", "ffprobe", "npm"] },
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
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.tests)) {
    throw new Error("TEST_SUITE_MANIFEST_INVALID: expected schemaVersion 1 and a tests array");
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
    .filter((entry) => entry.tags.some((tag) => tags.has(tag)))
    .map(({ path }) => path)
    .sort();
}

export function evaluateSuitePrerequisites(suiteName, options = {}) {
  const definition = TEST_SUITE_DEFINITIONS[suiteName];
  if (!definition) throw new Error(`TEST_SUITE_UNKNOWN: ${suiteName}`);
  const available = options.availableExecutables ?? new Set();
  const selected = options.manifest
    ? options.manifest.tests.filter((entry) => suiteName === "all" || definition.tags.some((tag) => entry.tags.includes(tag)))
    : [];
  const executables = new Set([
    ...definition.executables,
    ...selected.flatMap((entry) => entry.requires ?? []),
  ]);
  const nodeMajor = Number.parseInt((options.nodeVersion ?? process.versions.node).split(".")[0] ?? "0", 10);
  const missing = [...executables].filter((executable) => !available.has(executable));
  if (!Number.isFinite(nodeMajor) || nodeMajor < 20) missing.unshift("Node.js 20 or newer");
  return {
    ready: missing.length === 0,
    missing,
  };
}

export async function updateTestSuiteManifest(rootDir = repositoryRoot) {
  const tests = (await discoverTestFiles(rootDir)).map((path) => ({
    path,
    owner: ownerForTest(path),
    tags: tagsForTest(path),
    requires: prerequisitesForTest(path, tagsForTest(path)),
  }));
  const manifest = { schemaVersion: 1, tests };
  await writeFile(resolve(rootDir, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function ownerForTest(file) {
  const [root, packageName, ...rest] = file.split("/");
  if (["packages", "apps", "adapters"].includes(root) && rest.some((part) => part === "test" || part === "tests")) {
    return `${root}/${packageName}`;
  }
  return "shared";
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
    if (entry.isDirectory() && !excludedDirectories.has(entry.name)) {
      await walk(join(directory, entry.name), rootDir, files);
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(relative(rootDir, join(directory, entry.name)).split(sep).join("/"));
    }
  }
}

function tagsForTest(file) {
  const tags = new Set();
  if (file.startsWith("packages/") || file.startsWith("apps/") || file.startsWith("adapters/")) tags.add("unit");
  if (file.startsWith("tests/integration/")) {
    tags.add("integration");
    tags.add("fixture-e2e");
  }
  if (file.startsWith("tests/evaluation/") || file.startsWith("tests/golden/")) tags.add("fixture-e2e");
  if (file.startsWith("tests/speech/") || file.startsWith("tests/filler-removal/")) tags.add("unit");
  if (file.startsWith("tests/filler-removal/")) tags.add("fixture-e2e");
  if (file.startsWith("tests/release-gate/") || file.startsWith("tests/release-report/") || /release-gate/i.test(file)) tags.add("release-gate");
  if (/(?:contract|schema|protocol|capabilities|(?:^|\/)mcp(?:[-.]|\/))/i.test(file)) tags.add("contract");
  if (/(?:headless|rough-cut|render|semantic-media|local-media-registration)/i.test(file)) tags.add("headless");
  if (/(?:native|headed)/i.test(file)) tags.add("native");
  if (/(?:package-distribution|package-build-identity|clean-mcp-clients|codex-plugin)/i.test(file)) tags.add("package");
  if (file === "tests/integration/test-suites.test.ts") tags.add("unit");
  if (tags.size === 0) tags.add("unit");
  return [...tags].sort();
}

function prerequisitesForTest(file, tags) {
  const requirements = new Set();
  if (tags.includes("headless")) {
    requirements.add("ffmpeg");
    requirements.add("ffprobe");
  }
  if (file === "tests/integration/package-distribution.test.ts") requirements.add("npm");
  return [...requirements].sort();
}
