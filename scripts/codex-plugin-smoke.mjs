import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const codex = process.env.CODEX_BIN ?? "codex";
const codexHome = await mkdtemp(join(os.tmpdir(), "framekit-codex-plugin-"));
const environment = { ...process.env, CODEX_HOME: codexHome };

try {
  const marketplaceResult = await runCodex(["plugin", "marketplace", "add", repository, "--json"]);
  assert.equal(marketplaceResult.marketplaceName, "framekit");

  const installResult = await runCodex(["plugin", "add", "framekit@framekit", "--json"]);
  assert.equal(installResult.pluginId, "framekit@framekit");
  assert.equal(installResult.version, "0.1.0");

  const servers = await runCodex(["mcp", "list", "--json"]);
  assert.ok(Array.isArray(servers));
  const framekit = servers.find((server) => server.name === "framekit");
  assert.ok(framekit, "installed plugin must expose the Framekit MCP server");
  assert.equal(framekit.enabled, true);
  assert.deepEqual(framekit.transport, {
    type: "stdio",
    command: "npx",
    args: ["-y", "framekit", "mcp", "--editor", "final-cut-live", "--headless"],
    env: null,
    env_vars: [],
    cwd: null,
  });

  process.stdout.write("Framekit Codex plugin smoke test passed\n");
} finally {
  await rm(codexHome, { recursive: true, force: true });
}

async function runCodex(args) {
  const { stdout } = await exec(codex, args, {
    cwd: repository,
    env: environment,
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}
