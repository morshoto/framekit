import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const executable = new URL("./node_modules/.bin/framekit", import.meta.url).pathname;
const { stdout } = await promisify(execFile)(executable, ["help"]);
assert.match(stdout, /framekit mcp/);
const transport = new StdioClientTransport({
  command: executable,
  args: ["mcp", "--editor", "fixture"],
  env: { ...process.env, FRAMEKIT_STATE_DIR: new URL("./state", import.meta.url).pathname, FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0" },
  stderr: "pipe",
});
const client = new Client({ name: "consumer-runtime-smoke", version: "1.0.0" });
try {
  await client.connect(transport);
  const result = await client.listTools();
  assert.ok(result.tools.some((tool) => tool.name === "connection.status"));
} finally {
  await client.close();
  await transport.close();
}
