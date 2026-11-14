import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = new URL("../..", import.meta.url).pathname;

test("fixture MCP smoke completes stdio handshake and status call", () => {
  const result = spawnSync(process.execPath, ["scripts/fixture-mcp-smoke.mjs"], {
    cwd: resolve(repositoryRoot),
    encoding: "utf8",
    timeout: 30_000,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /connection\.status.*ready/i);
});
