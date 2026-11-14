import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { promisify } from "node:util";
const exec = promisify(execFile);
const childEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"));

// #733 cycles: execute the public runner in a controlled checkout. Prove selection,
// isolation, prerequisites, failure propagation and watch cleanup before changing it.
async function checkout(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "framekit-runner-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  for (const file of ["run-tests-with-isolated-home.mjs", "test-suites.mjs", "ci"]) {
    await cp(resolve("scripts", file), join(root, "scripts", file), { recursive: true });
  }
  await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
  await mkdir(join(root, "tests/integration"), { recursive: true });
  await mkdir(join(root, "tests/documentation"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  const files = ["tests/integration/selected.test.ts", "tests/integration/other.test.ts", "tests/documentation/docs.test.mjs"];
  await writeFile(join(root, files[0]!), `import test from 'node:test'; import { writeFileSync, statSync } from 'node:fs';
    test('wanted', () => { writeFileSync('observed.json', JSON.stringify({env: process.env, mode: statSync(process.env.HOME).mode})); console.log('WANTED'); });
    test('unwanted', () => { throw Error('UNWANTED'); });`);
  await writeFile(join(root, files[1]!), "throw Error('WRONG_FILE');");
  await writeFile(join(root, files[2]!), "import test from 'node:test'; test('docs', () => console.log('DOCS')); ");
  const manifest = { schemaVersion: 2, tests: files.map(path => ({ path, owner: "scripts/testing", tags: ["unit"],
    reviewed: true, evidence: "process", dependsOn: ["scripts"], platforms: ["any"], network: "none",
    requires: path.includes('other') ? ["framekit-missing-tool"] : [] })) };
  const save = () => writeFile(join(root, "scripts/test-suite-manifest.json"), JSON.stringify(manifest));
  await save();
  const run = (args: string[]) => exec(process.execPath, ["scripts/run-tests-with-isolated-home.mjs", ...args], {
    cwd: root, timeout: 15_000, env: { ...childEnvironment, HOME: process.env.FRAMEKIT_TEST_ORIGINAL_HOME ?? process.env.HOME,
      FRAMEKIT_TEST_REPORT_DIR: "", FRAMEKIT_EDITOR: "final-cut-live", FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "1", FRAMEKIT_FINAL_CUT_HEADLESS: "0", FRAMEKIT_AUTO_CONNECT: "1", FRAMEKIT_FINAL_CUT_LIBRARY_HEADED: "1" },
  });
  return { root, manifest, save, run, files };
}

test("focused file and name selection preserves read-only HOME, safety and cleanup", async t => {
  const { root, run, files } = await checkout(t);
  const result = await run(["--file", files[0]!, "--test-name-pattern", "^wanted$"]);
  assert.match(result.stdout, /WANTED/);
  assert.doesNotMatch(result.stdout, /WRONG_FILE|DOCS/);
  const { env, mode } = JSON.parse(await readFile(join(root, "observed.json"), "utf8"));
  assert.equal(mode & 0o222, 0);
  for (const key of ["HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "FRAMEKIT_STATE_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "npm_config_cache"]) {
    assert.ok(env[key].startsWith(env.FRAMEKIT_TEST_STATE_DIR + '/'), key);
  }
  for (const [key, value] of Object.entries({ FRAMEKIT_EDITOR: "fixture", FRAMEKIT_COMMIT_VALIDATION: "1", FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0", FRAMEKIT_FINAL_CUT_HEADLESS: "1", FRAMEKIT_AUTO_CONNECT: "0", FRAMEKIT_FINAL_CUT_LIBRARY_HEADED: "0" })) assert.equal(env[key], value, key);
  assert.equal(existsSync(env.FRAMEKIT_TEST_STATE_DIR), false);
});

test("focused prerequisites and platform requirements apply only to selected files", async t => {
  const { manifest, save, run, files } = await checkout(t);
  assert.match((await run(["--file", files[0]!, "--check-only"])).stdout, /PREREQUISITES_READY/);
  await assert.rejects(run(["--file", files[1]!, "--check-only"]), /framekit-missing-tool/);
  manifest.tests[0]!.platforms = [process.platform === 'darwin' ? 'linux' : 'darwin'];
  await save();
  await assert.rejects(run(["--file", files[0]!, "--check-only"]), /platform/);
});

test("unknown flags, empty matches, unregistered files and failure status fail clearly", async t => {
  const { root, run, files } = await checkout(t);
  for (const args of [["--bogus"], ["--file"], ["--test-name-pattern"], ["--file", "../outside.test.ts"], ["unknown-suite"]]) {
    await assert.rejects(run(args), /TEST_ARGUMENT|TEST_SUITE_UNKNOWN|TEST_FILE_UNKNOWN/);
  }
  await assert.rejects(run(["--file", files[0]!, "--test-name-pattern", "no-match"]), /TEST_NAME_NO_MATCH/);
  await assert.rejects(run(["--file", files[0]!, "--test-name-pattern", "["]), (error: any) =>
    error.code !== 0 && /--test-name-pattern|regular expression/i.test(error.stderr));
  await assert.rejects(run(["--file", files[0]!]), (error: any) => error.code === 1 && /UNWANTED/.test(error.stdout));
  const { env } = JSON.parse(await readFile(join(root, "observed.json"), "utf8"));
  assert.equal(existsSync(env.FRAMEKIT_TEST_STATE_DIR), false);
  assert.match((await run(["--file", files[2]!])).stdout, /DOCS/);
});

test("watch reruns the selected test and cleans isolated state on termination", { timeout: 20_000 }, async t => {
  const { root, files } = await checkout(t);
  const child = spawn(process.execPath, ["scripts/run-tests-with-isolated-home.mjs", "--watch", "--file", files[0]!, "--test-name-pattern", "^wanted$"], {
    cwd: root, env: { ...childEnvironment, HOME: process.env.FRAMEKIT_TEST_ORIGINAL_HOME ?? process.env.HOME, FRAMEKIT_TEST_REPORT_DIR: "" }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  t.after(async () => { child.kill('SIGTERM'); await closed; });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  async function until(predicate: () => boolean) {
    const deadline = Date.now() + 8000;
    while (!predicate()) {
      if (child.exitCode !== null || Date.now() > deadline) assert.fail(output);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  await until(() => output.includes('WANTED'));
  const { env } = JSON.parse(await readFile(join(root, 'observed.json'), 'utf8'));
  await writeFile(join(root, files[0]!), (await readFile(join(root, files[0]!), 'utf8')).replace('WANTED', 'RERUN'));
  await until(() => output.includes('RERUN'));
  child.kill('SIGTERM');
  await closed;
  assert.equal(existsSync(env.FRAMEKIT_TEST_STATE_DIR), false);
});

test('selection reports do not count a name filter as a selected file', async t => {
  const { root, files } = await checkout(t);
  const fixture = join(root, files[0]!);
  await writeFile(fixture, (await readFile(fixture, 'utf8')).replace("test('wanted'", "test('wanted.test.ts'"));
  const reports = join(root, 'reports');
  await exec(process.execPath, ['scripts/run-tests-with-isolated-home.mjs', '--file', files[0]!, '--test-name-pattern', 'wanted.test.ts'], {
    cwd: root, env: { ...childEnvironment, HOME: process.env.FRAMEKIT_TEST_ORIGINAL_HOME ?? process.env.HOME, FRAMEKIT_TEST_REPORT_DIR: reports },
  });
  const metadata = JSON.parse(await readFile(join(reports, 'all-metadata.json'), 'utf8'));
  assert.deepEqual(metadata.selectedFiles, [files[0]]);
});
