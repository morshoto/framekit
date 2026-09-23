import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { assertMcpServerVersion } from "./mcp-version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function validateMcpServerVersion({
  packageVersion,
  executable = join(root, "bin/framekit.mjs"),
}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [executable, "mcp", "--editor", "fixture"],
    stderr: "pipe",
  });
  const client = new Client({ name: "framekit-release-version-check", version: "0.0.0" });

  try {
    await client.connect(transport);
    return assertMcpServerVersion(client.getServerVersion()?.version, packageVersion, "release package");
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

async function main() {
  const packageManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const version = await validateMcpServerVersion({ packageVersion: packageManifest.version });
  process.stdout.write(`MCP server version valid for ${packageManifest.name}@${version}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
