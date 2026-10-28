import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { checkScriptReferences } from "../../scripts/check-script-references.mjs";

const repository = resolve(process.cwd());

test("package, workflow, and documentation script references resolve", async () => {
  assert.deepEqual(await checkScriptReferences(repository), []);
  const packageJson = JSON.parse(await readFile(resolve(repository, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const workflow = await readFile(resolve(repository, ".github/workflows/typescript.yml"), "utf8");
  assert.equal(packageJson.scripts?.["check:scripts"], "node scripts/check-script-references.mjs");
  assert.match(workflow, /run: pnpm run check:scripts/);
});

test("reports missing package commands, workflow commands, links, and executables", async () => {
  const root = await mkdtemp(join(tmpdir(), "framekit-script-references-"));
  try {
    await mkdir(join(root, ".github/workflows"), { recursive: true });
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({
      scripts: { broken: "node scripts/missing-command.mjs" },
      bin: { framekit: "./bin/missing-executable.mjs" },
    }));
    await writeFile(join(root, ".github/workflows/ci.yml"), "steps:\n  - run: node scripts/missing-workflow.mjs\n");
    await writeFile(join(root, "docs/testing.md"), "[missing](../scripts/missing-link.mjs)\n\nRun `node scripts/missing-doc-command.mjs`.\n");

    assert.deepEqual(await checkScriptReferences(root), [
      ".github/workflows/ci.yml runs missing script scripts/missing-workflow.mjs",
      "docs/testing.md links to missing script ../scripts/missing-link.mjs",
      "docs/testing.md runs missing script scripts/missing-doc-command.mjs",
      "package.json bin.framekit points to missing executable bin/missing-executable.mjs",
      "package.json scripts.broken runs missing script scripts/missing-command.mjs",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release scripts have a responsibility owner and retain old entrypoints", async () => {
  const packageJson = JSON.parse(await readFile(resolve(repository, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const legacyRunner = await readFile(resolve(repository, "scripts/run-release-gate.ts"), "utf8");
  const legacyArguments = await readFile(resolve(repository, "scripts/run-release-gate-args.ts"), "utf8");
  const implementation = await readFile(resolve(repository, "scripts/release/run-release-gate.ts"), "utf8");

  assert.equal(packageJson.scripts?.["release-gate"], "tsx scripts/release/run-release-gate.ts");
  assert.match(legacyRunner, /\.\/release\/run-release-gate\.js/);
  assert.match(legacyArguments, /\.\/release\/run-release-gate-args\.js/);
  assert.match(implementation, /runRepositoryChecks/);
});

test("legacy release runner reaches argument validation before running checks", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/run-release-gate.ts", "--invalid"], {
    cwd: repository,
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /USAGE: only --output-dir and --headed-evidence-dir are supported/);
});

test("speech analyzers belong to the MCP app and ship in the clean package", async () => {
  const packageJson = JSON.parse(await readFile(resolve(repository, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const wrapper = await readFile(resolve(repository, "scripts/speech-analyzer-wrapper.mjs"), "utf8");
  const backend = await readFile(resolve(repository, "scripts/whisper-speech-backend.py"), "utf8");
  const packageCopy = await readFile(resolve(repository, "scripts/build/copy-package-runtime-assets.mjs"), "utf8");
  const distributionTest = await readFile(resolve(repository, "tests/integration/package-distribution.test.ts"), "utf8");

  assert.match(wrapper, /apps\/mcp-server\/runtime\/speech-analyzer-wrapper\.mjs/);
  assert.match(backend, /"apps" \/ "mcp-server" \/ "runtime" \/ "whisper-speech-backend\.py"/);
  assert.match(packageJson.scripts?.["build:package"] ?? "", /copy-package-runtime-assets\.mjs/);
  assert.match(packageCopy, /apps\/mcp-server\/runtime/);
  assert.match(distributionTest, /dist-package\/apps\/mcp-server\/runtime\/speech-analyzer-wrapper\.mjs/);
  assert.match(distributionTest, /dist-package\/apps\/mcp-server\/runtime\/whisper-speech-backend\.py/);
});
