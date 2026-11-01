import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export async function main() {
  const temporaryDirectory = await mkdtemp(join(os.tmpdir(), "framekit-fixture-mcp-"));
  const stateDirectory = join(temporaryDirectory, "state");
  const cacheDirectory = join(temporaryDirectory, "cache");
  await Promise.all([mkdir(stateDirectory), mkdir(cacheDirectory)]);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(repositoryRoot, "apps/mcp-server/src/main.ts")],
    cwd: repositoryRoot,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: temporaryDirectory,
      TMPDIR: os.tmpdir(),
      XDG_CACHE_HOME: cacheDirectory,
      FRAMEKIT_EDITOR: "fixture",
      FRAMEKIT_STATE_DIR: stateDirectory,
      FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0",
      FRAMEKIT_AUTO_CONNECT: "0",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "framekit-fixture-smoke", version: "1.0.0" });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === "connection.status"), "connection.status is registered");

    const statusResult = await client.callTool({ name: "connection.status", arguments: {} });
    assert.ok(!statusResult.isError, "connection.status succeeds");
    const statusText = statusResult.content.find((item) => item.type === "text")?.text;
    assert.ok(statusText, "connection.status returns JSON text");
    assert.equal(JSON.parse(statusText).state, "ready");
    process.stdout.write("Fixture MCP stdio smoke passed: connection.status ready.\n");
  } finally {
    await client.close();
    await transport.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
