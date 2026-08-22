import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const exec = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("published package contains the runnable Framekit CLI and MCP sources", async () => {
  const manifest = JSON.parse(await readFile(resolve(repository, "package.json"), "utf8")) as {
    name?: string;
    private?: boolean;
    bin?: Record<string, string>;
    dependencies?: Record<string, string>;
    files?: string[];
  };

  assert.equal(manifest.name, "@morshoto/framekit");
  assert.equal(manifest.private, false);
  assert.equal(manifest.bin?.framekit, "./bin/framekit.mjs");
  assert.equal(manifest.dependencies?.tsx, undefined, "published CLI must not depend on the development loader");
  assert.deepEqual(manifest.files, ["bin", "dist-package"]);

  const { stdout } = await exec("npm", ["pack", "--dry-run", "--json"], { cwd: repository });
  const [packed] = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
  const paths = packed.files.map((file) => file.path);
  for (const requiredPath of [
    "bin/framekit.mjs",
    "dist-package/apps/cli/src/main.js",
    "dist-package/apps/mcp-server/src/main.js",
    "dist-package/packages/runtime/src/index.js",
    "dist-package/adapters/final-cut/typescript/src/index.js",
  ]) {
    assert.ok(paths.includes(requiredPath), `${requiredPath} must be included in the npm package`);
  }
  assert.equal(paths.some((path) => path.startsWith("tests/")), false);
  assert.equal(paths.some((path) => path.startsWith("adapters/final-cut/swift-bridge/")), false);
});

test("clean install of the packed package starts the headless Final Cut MCP server", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-package-smoke-"));
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;

  try {
    const { stdout } = await exec("npm", ["pack", "--json", "--pack-destination", directory], {
      cwd: repository,
    });
    const [packed] = JSON.parse(stdout) as Array<{ filename: string }>;
    const archive = join(directory, packed.filename);
    await exec("npm", ["install", "--ignore-scripts", archive], { cwd: directory });

    const executable = join(directory, "node_modules", ".bin", "framekit");
    const help = await exec(executable, ["help"], { cwd: directory });
    assert.match(help.stdout, /framekit mcp --editor final-cut-live \[--headless\]/);

    transport = new StdioClientTransport({
      command: executable,
      args: ["mcp", "--editor", "final-cut-live", "--headless"],
      cwd: directory,
      stderr: "pipe",
    });
    client = new Client({ name: "framekit-package-smoke", version: "0.1.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "connection.status"));
    assert.ok(tools.tools.some((tool) => tool.name === "editor.live.inspect"));
  } finally {
    await client?.close();
    await transport?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
