import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { parse } from "@babel/parser";
import {
  compareTestInventory,
  discoverTestFiles,
  evaluateSuitePrerequisites,
  loadTestSuiteManifest,
  selectTestFiles,
  updateTestSuiteManifest,
} from "../../../scripts/test-suites.mjs";

const repository = resolve(process.cwd());

test("test inventory retains every baseline test and detects uncollected files", async () => {
  const manifest = await loadTestSuiteManifest(repository);
  const inventory = new Set(manifest.tests.map(({ path }) => path));
  const discovered = await discoverTestFiles(repository);
  const projectStoreTest = manifest.tests.find(({ path }) => path === "packages/runtime/test/project-store.test.ts");

  assert.equal(inventory.size, manifest.tests.length);
  assert.ok(inventory.has("packages/runtime/test/project-store.test.ts"));
  assert.ok(inventory.has("tests/tooling/validation/test-suites.test.ts"));
  assert.equal(projectStoreTest?.owner, "packages/runtime");
  assert.ok(projectStoreTest?.tags.includes("unit"));
  assert.deepEqual(compareTestInventory([...inventory], discovered), { missing: [], unregistered: [] });
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
  assert.ok(selectTestFiles(manifest, "headless").includes("tests/workflows/rough-cut/headless-project-mcp.test.ts"));
  assert.ok(selectTestFiles(manifest, "contract").includes("tests/mcp/tools/skill-mcp-contract.test.ts"));
});

test("test suites report unavailable prerequisites before execution", async () => {
  const manifest = await loadTestSuiteManifest(repository);
  const status = evaluateSuitePrerequisites("headless", {
    platform: "linux",
    availableExecutables: new Set(["node", "git"]),
    manifest,
  });

  assert.deepEqual(status, {
    ready: false,
    missing: ["ffmpeg", "ffprobe"],
  });

  const contractStatus = evaluateSuitePrerequisites("contract", {
    platform: "linux",
    availableExecutables: new Set(["node", "git"]),
    manifest,
  });
  assert.deepEqual(contractStatus, { ready: true, missing: [] });
  assert.deepEqual(evaluateSuitePrerequisites("unit", {
    availableExecutables: new Set(["node", "git"]),
    nodeVersion: "18.19.0",
  }), { ready: false, missing: ["Node.js 20 or newer"] });
});

test("fast CI and post-merge validation preserve reviewed test coverage", async () => {
  const workflow = await readFile(resolve(repository, ".github/action/test/action.yml"), "utf8");
  const security = await readFile(resolve(repository, ".github/workflows/security.yml"), "utf8");
  const packageJson = JSON.parse(await readFile(resolve(repository, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const documentation = await readFile(resolve(repository, "tests/README.md"), "utf8");

  assert.match(workflow, /run: pnpm run check:skill-tools/);
  assert.match(workflow, /validation-level:/);
  assert.match(workflow, /run: pnpm run test:fast/);
  assert.match(workflow, /run: pnpm run test\s*$/m);
  assert.match(security, /uses: \.\/\.github\/action\/test/);
  assert.match(security, /validation-level: full/);
  assert.match(workflow, /Install FFmpeg fixture toolchain/);
  const manifest = await loadTestSuiteManifest(repository);
  const fast = selectTestFiles(manifest, "fast");
  const deepOnly = ["tests/workflows/basic-editing/finalcut-mcp.test.ts", "tests/workflows/rough-cut/headless-project-mcp.test.ts"];
  for (const suite of ["unit", "contract"]) {
    for (const file of selectTestFiles(manifest, suite)) {
      assert.equal(fast.includes(file), !deepOnly.includes(file), file);
    }
  }
  for (const file of deepOnly) assert.ok(selectTestFiles(manifest, "all").includes(file), file);
  for (const file of ["tests/workflows/basic-editing/basic-editing-mvp.test.ts", "tests/runtime/projects/runtime.test.ts", "tests/tooling/ci/codeql-workflow.test.ts"]) {
    assert.ok(fast.includes(file), file);
  }
  assert.ok(selectTestFiles(manifest, "all").length > fast.length);
  for (const [script, suite] of [
    ["test:fast", "fast"],
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
  assert.equal(packageJson.scripts?.["test:package"], "node scripts/run-tests-with-isolated-home.mjs package");
  assert.match(documentation, /ffmpeg.*ffprobe/i);
  assert.match(documentation, /does not launch Final Cut/i);
});


test("inventory regeneration preserves reviewed metadata and flags new files for review", async t => {
  const root = await mkdtemp('/tmp/framekit-inventory-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'tests/integration'), { recursive: true });
  const entry = { path: 'tests/integration/owned.test.ts', owner: 'packages/runtime', tags: ['contract'],
    reviewed: true, evidence: 'fixture', dependsOn: ['packages/runtime'], platforms: ['any'], network: 'none', requires: ['custom-tool'] };
  await writeFile(join(root, entry.path), '');
  await writeFile(join(root, 'scripts/test-suite-manifest.json'), JSON.stringify({ schemaVersion: 2, tests: [entry] }));
  assert.deepEqual((await updateTestSuiteManifest(root)).tests, [entry]);
  await writeFile(join(root, 'tests/integration/new.test.ts'), '');
  const updated = await updateTestSuiteManifest(root);
  assert.deepEqual(updated.tests.find(e => e.path === entry.path), entry);
  assert.equal(updated.tests.find(e => e.path.endsWith('new.test.ts'))?.reviewed, false);
  await assert.rejects(loadTestSuiteManifest(root), /METADATA_UNREVIEWED/);
});

test("discovery includes documentation but deliberately delegates Docs app runners", async t => {
  const root = await mkdtemp('/tmp/framekit-discovery-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const included = ['tests/tooling/ci/policy.test.mjs', 'tests/runtime/editing/nested/domain.test.ts', 'packages/runtime/test/domain.test.ts'];
  const excluded = ['apps/docs/src/lib/a.test.ts', 'apps/docs/test/export.test.mjs', 'tests/fixture/node_modules/hidden.test.ts', 'tests/fixture/dist/hidden.test.ts', 'tests/research/unsafe.test.ts'];
  for (const file of [...included, ...excluded]) {
    await mkdir(resolve(root, file, '..'), { recursive: true });
    await writeFile(join(root, file), '');
  }
  assert.deepEqual(await discoverTestFiles(root), included.sort());
});


test("relocations preserve every reviewed suite member exactly once", async () => {
  const baseline = JSON.parse(await readFile(resolve(repository, 'tests/support/testing/relocations.json'), 'utf8'));
  const manifest = await loadTestSuiteManifest(repository);
  const discovered = new Set(await discoverTestFiles(repository));
  for (const [suite, previous] of Object.entries(baseline.suites) as Array<[string, string[]]>) {
    const actual = selectTestFiles(manifest, suite);
    assert.equal(new Set(actual).size, actual.length, suite);
    for (const old of previous) {
      const current = discovered.has(baseline.paths[old]) ? baseline.paths[old] : old;
      assert.ok(actual.includes(current), `${suite}: lost ${old} -> ${current}`);
      if (current !== old) assert.equal(discovered.has(old), false, `duplicate execution of ${old}`);
    }
  }
});

test("duplicate inventory entries are rejected rather than executing a test twice", async t => {
  const root = await mkdtemp('/tmp/framekit-duplicate-inventory-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  const manifest = await loadTestSuiteManifest(repository);
  await writeFile(join(root, 'scripts/test-suite-manifest.json'), JSON.stringify({ ...manifest, tests: [manifest.tests[0], manifest.tests[0]] }));
  await assert.rejects(loadTestSuiteManifest(root), /TEST_METADATA_INVALID/);
});


test("relocations preserve declared test identities through the reviewed path map", async () => {
  const baseline = JSON.parse(await readFile(resolve(repository, 'tests/support/testing/relocations.json'), 'utf8'));
  for (const [old, expected] of Object.entries(baseline.testNames) as Array<[string, string[]]>) {
    const current = baseline.paths[old] ?? old;
    const source = await readFile(resolve(repository, current), 'utf8');
    const actual: string[] = [];
    const visit = (node: any) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'CallExpression' && (node.callee?.name === 'test' || node.callee?.object?.name === 'test')
        && ['StringLiteral', 'TemplateLiteral'].includes(node.arguments[0]?.type)) actual.push(source.slice(node.arguments[0].start, node.arguments[0].end));
      for (const [key, value] of Object.entries(node)) if (!['loc', 'comments', 'tokens'].includes(key)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') visit(value);
      }
    };
    visit(parse(source, { sourceType: 'module', plugins: ['typescript'] }));
    assert.deepEqual(actual.sort(), [...expected, ...(baseline.addedTestNames?.[old] ?? [])].sort(), current);
  }
});


test("platform-only prerequisites block SDK tests only in their execution environment", () => {
  const manifest = { schemaVersion: 2 as const, tests: [{ path: 'tests/adapters/sdk.test.ts', owner: 'adapters/final-cut/typescript',
    reviewed: true, evidence: 'sdk' as const, network: 'none' as const, platforms: ['any'], dependsOn: ['adapters/final-cut/typescript'],
    tags: ['native'], requires: [], conditionalRequires: [{ platform: 'darwin', executables: ['xcrun'] }] }] };
  const options = { manifest, availableExecutables: new Set(['node']) };
  assert.deepEqual(evaluateSuitePrerequisites('native', { ...options, platform: 'linux' }), { ready: true, missing: [] });
  assert.deepEqual(evaluateSuitePrerequisites('native', { ...options, platform: 'darwin' }), { ready: false, missing: ['xcrun'] });
});


test("golden and filler aliases use the same isolated runner and reviewed selection", async () => {
  const manifest = await loadTestSuiteManifest(repository);
  const packageJson = JSON.parse(await readFile(resolve(repository, 'package.json'), 'utf8'));
  for (const [script, suite, prefix] of [['test:golden', 'golden', 'tests/workflows/golden/'], ['test:filler-removal', 'filler-removal', 'tests/workflows/filler-removal/']]) {
    assert.equal(packageJson.scripts[script], `node scripts/run-tests-with-isolated-home.mjs ${suite}`);
    assert.deepEqual(selectTestFiles(manifest, suite), manifest.tests.filter(entry => entry.path.startsWith(prefix)).map(entry => entry.path).sort());
  }
});


test("reviewed metadata rejects malformed evidence and execution requirements", async t => {
  const root = await mkdtemp('/tmp/framekit-invalid-metadata-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  const manifest = await loadTestSuiteManifest(repository);
  const base = manifest.tests[0]!;
  for (const patch of [{ reviewed: 'yes' }, { requires: [1] }, { dependsOn: [''] }, { tags: ['unit', 'unit'] },
    { path: '../outside.test.ts' }, { conditionalRequires: [{ platform: 'unknown', executables: ['tool'] }] },
    { expectedSkips: [{ name: 'case', reason: '', platforms: ['any'] }] }]) {
    await writeFile(join(root, 'scripts/test-suite-manifest.json'), JSON.stringify({ schemaVersion: 2, tests: [{ ...base, ...patch }] }));
    await assert.rejects(loadTestSuiteManifest(root), /TEST_METADATA_(?:INVALID|UNREVIEWED)/, JSON.stringify(patch));
  }
});
