import assert from "node:assert/strict";
import { lstat, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import test from "node:test";

test("aggregate tests run with a read-only home and isolated writable state", {
  skip: !process.env.FRAMEKIT_TEST_STATE_DIR,
}, async () => {
  const testStateDirectory = process.env.FRAMEKIT_TEST_STATE_DIR;
  const homeDirectory = process.env.HOME;
  const originalHomeDirectory = process.env.FRAMEKIT_TEST_ORIGINAL_HOME;
  const framekitStateDirectory = process.env.FRAMEKIT_STATE_DIR;

  assert.ok(testStateDirectory, "test runner must provide FRAMEKIT_TEST_STATE_DIR");
  assert.ok(homeDirectory, "test runner must provide an isolated HOME");
  assert.ok(originalHomeDirectory, "test runner must record the caller HOME for comparison");
  assert.ok(framekitStateDirectory, "test runner must provide FRAMEKIT_STATE_DIR");
  assert.notEqual(resolve(homeDirectory), resolve(originalHomeDirectory));
  assert.ok(isWithin(testStateDirectory, homeDirectory));
  assert.ok(isWithin(testStateDirectory, framekitStateDirectory));

  for (const variable of ["TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "npm_config_cache"]) {
    const value = process.env[variable];
    assert.ok(value, `test runner must isolate ${variable}`);
    assert.ok(isWithin(testStateDirectory, value), `${variable} must stay under the test state directory`);
  }

  const homeMode = (await lstat(homeDirectory)).mode;
  assert.equal(homeMode & 0o222, 0, "sentinel HOME must be read-only");

  const blockedWrite = join(homeDirectory, "framekit-test-home-write-blocked");
  await assert.rejects(writeFile(blockedWrite, "must not persist"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok("code" in error && (error.code === "EACCES" || error.code === "EPERM"));
    return true;
  });

  const safeWrite = join(framekitStateDirectory, "isolated-state-write.txt");
  try {
    await writeFile(safeWrite, "isolated");
  } finally {
    await rm(safeWrite, { force: true });
  }

  assert.equal(os.homedir(), homeDirectory);
});

function isWithin(parent: string, candidate: string): boolean {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return relativePath === ""
    || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}
