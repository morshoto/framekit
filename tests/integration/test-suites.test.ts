import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  compareTestInventory,
  discoverTestFiles,
  evaluateSuitePrerequisites,
  loadTestSuiteManifest,
  selectTestFiles,
} from "../../scripts/test-suites.mjs";

const repository = resolve(process.cwd());

test("test inventory retains every baseline test and detects uncollected files", async () => {
  const manifest = await loadTestSuiteManifest(repository);
  const inventory = new Set(manifest.tests.map(({ path }) => path));
  const discovered = await discoverTestFiles(repository);
  const aggregateRunner = await readFile(resolve(repository, "scripts/run-tests-with-isolated-home.mjs"), "utf8");
  const projectStoreTest = manifest.tests.find(({ path }) => path === "packages/runtime/test/project-store.test.ts");

  assert.equal(inventory.size, manifest.tests.length);
  assert.ok(inventory.has("packages/runtime/test/project-store.test.ts"));
  assert.ok(inventory.has("tests/integration/test-suites.test.ts"));
  assert.equal(projectStoreTest?.owner, "packages/runtime");
  assert.ok(projectStoreTest?.tags.includes("unit"));
  assert.deepEqual(compareTestInventory([...inventory], discovered), { missing: [], unregistered: [] });
  assert.match(aggregateRunner, /discoverTestFiles/);
  assert.match(aggregateRunner, /compareTestInventory/);
  assert.match(aggregateRunner, /selectTestFiles/);
  assert.match(aggregateRunner, /documentationTestFiles\.length > 0/);
  assert.match(aggregateRunner, /runCommand\(process\.execPath, \["--test", \.\.\.documentationTestFiles\], environment\)/);
  assert.deepEqual(compareTestInventory([...inventory], [...inventory].slice(1)), {
    missing: ["packages/runtime/test/project-store.test.ts"],
    unregistered: [],
  });
  assert.deepEqual(compareTestInventory([...inventory].slice(1), [...inventory]), {
    missing: [],
    unregistered: ["packages/runtime/test/project-store.test.ts"],
  });
});

test("suite tags keep unit, contract, fixture, headless, native, package and release coverage discoverable", async () => {
  const manifest = await loadTestSuiteManifest(repository);
  const tags = new Set(manifest.tests.flatMap(({ tags }) => tags));

  for (const tag of ["unit", "contract", "fixture-e2e", "headless", "native", "package", "release-gate"]) {
    assert.ok(tags.has(tag), `the inventory includes the ${tag} tag`);
  }

  assert.ok(selectTestFiles(manifest, "unit").includes("packages/runtime/test/project-store.test.ts"));
  assert.ok(selectTestFiles(manifest, "headless").includes("tests/integration/headless-project-mcp.test.ts"));
  assert.ok(selectTestFiles(manifest, "contract").includes("tests/integration/skill-mcp-contract.test.ts"));
});

test("test suites report unavailable prerequisites before execution", async () => {
  const manifest = await loadTestSuiteManifest(repository);
  const status = evaluateSuitePrerequisites("headless", {
    platform: "linux",
    availableExecutables: new Set(["node"]),
    manifest,
  });

  assert.deepEqual(status, {
    ready: false,
    missing: ["ffmpeg", "ffprobe"],
  });

  const contractStatus = evaluateSuitePrerequisites("contract", {
    platform: "linux",
    availableExecutables: new Set(["node"]),
    manifest,
  });
  assert.deepEqual(contractStatus, { ready: false, missing: ["ffmpeg", "ffprobe"] });
  assert.deepEqual(evaluateSuitePrerequisites("unit", {
    availableExecutables: new Set(["node"]),
    nodeVersion: "18.19.0",
  }), { ready: false, missing: ["Node.js 20 or newer"] });
});

test("CI keeps the inventory-driven aggregate suite as a required gate", async () => {
  const workflow = await readFile(resolve(repository, ".github/workflows/typescript.yml"), "utf8");
  const packageJson = JSON.parse(await readFile(resolve(repository, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const documentation = await readFile(resolve(repository, "tests/README.md"), "utf8");

  assert.match(workflow, /run: pnpm run test/);
  assert.match(workflow, /Install FFmpeg fixture toolchain/);
  for (const [script, suite] of [
    ["test:unit", "unit"],
    ["test:contracts", "contract"],
    ["test:fixtures", "fixture"],
    ["test:integration", "integration"],
    ["test:headless", "headless"],
    ["test:native", "native"],
    ["test:release-gate", "release-gate"],
  ]) {
    assert.equal(packageJson.scripts?.[script], `node scripts/run-tests-with-isolated-home.mjs ${suite}`);
    assert.match(documentation, new RegExp(`pnpm run ${script.replace(":", "\\:")}`));
  }
  assert.match(packageJson.scripts?.["test:package"] ?? "", /build:package/);
  assert.match(documentation, /ffmpeg.*ffprobe/i);
  assert.match(documentation, /does not launch Final Cut/i);
});
