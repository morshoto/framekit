import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(repository, relativePath), "utf8"));
}

test("Framekit plugin registers the published headless Final Cut MCP command", async () => {
  const manifest = await readJson("plugins/framekit/.codex-plugin/plugin.json") as {
    name?: string;
    version?: string;
    skills?: string;
    mcpServers?: string;
    interface?: { displayName?: string; category?: string; capabilities?: string[] };
  };
  assert.equal(manifest.name, "framekit");
  assert.match(manifest.version ?? "", /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(manifest.interface?.displayName, "Framekit");
  assert.equal(manifest.interface?.category, "Developer Tools");
  assert.deepEqual(manifest.interface?.capabilities, ["Interactive"]);

  const mcp = await readJson("plugins/framekit/.mcp.json") as {
    mcpServers?: Record<string, { command?: string; args?: string[]; env?: unknown }>;
  };
  assert.deepEqual(mcp.mcpServers?.framekit, {
    command: "npx",
    args: ["-y", "framekit", "mcp", "--editor", "final-cut-live", "--headless"],
  });
});

test("Framekit is discoverable from the repository marketplace", async () => {
  const marketplace = await readJson(".agents/plugins/marketplace.json") as {
    name?: string;
    interface?: { displayName?: string };
    plugins?: Array<unknown>;
  };
  assert.equal(marketplace.name, "framekit");
  assert.equal(marketplace.interface?.displayName, "Framekit");
  assert.deepEqual(marketplace.plugins, [
    {
      name: "framekit",
      source: { source: "local", path: "./plugins/framekit" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Developer Tools",
    },
  ]);
});

test("Framekit plugin guidance preserves live capability and safety boundaries", async () => {
  const skill = await readFile(resolve(repository, "plugins/framekit/skills/framekit/SKILL.md"), "utf8");
  for (const expected of [
    "connection.status",
    "editor.live.inspect",
    "--headless",
    "CAPABILITY_UNAVAILABLE",
    "preview",
    "undo",
    "Accessibility",
    "Automation",
  ]) {
    assert.match(skill, new RegExp(expected.replace(".", "\\."), "i"));
  }
});

test("CI runs the clean Codex plugin installation smoke test", async () => {
  const packageManifest = await readJson("package.json") as { scripts?: Record<string, string> };
  assert.equal(packageManifest.scripts?.["test:codex-plugin"], "node scripts/codex-plugin-smoke.mjs");

  const workflow = await readFile(resolve(repository, ".github/workflows/typescript.yml"), "utf8");
  assert.match(workflow, /npm install --global @openai\/codex/);
  assert.match(workflow, /pnpm run test:codex-plugin/);
});

test("user documentation leads with plugin installation and explains first-run boundaries", async () => {
  const readme = await readFile(resolve(repository, "README.md"), "utf8");
  const gettingStarted = await readFile(resolve(repository, "docs/getting-started.md"), "utf8");
  const installation = await readFile(resolve(repository, "docs/final-cut/installation.md"), "utf8");

  for (const content of [readme, gettingStarted]) {
    assert.match(content, /codex plugin marketplace add morshoto\/framekit/);
    assert.match(content, /\/plugins/);
    assert.match(content, /new\s+Codex session/i);
    assert.doesNotMatch(content, /codex mcp add framekit/);
  }

  for (const expected of [
    "Workflow Extension",
    "Accessibility",
    "Automation",
    "headless",
    "connection.status",
    "capability",
  ]) {
    assert.match(installation, new RegExp(expected.replace(".", "\\."), "i"));
  }
});
