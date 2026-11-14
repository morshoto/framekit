import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentVideoRuntime } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createCliHeadlessProjectService } from "../../apps/cli/src/headless-projects.js";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

const exec = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("CLI workspace identity is private and the root bin is the only public export", async () => {
  const rootManifest = JSON.parse(await readFile(join(repository, "package.json"), "utf8")) as {
    bin?: Record<string, string>;
    exports?: Record<string, unknown>;
    main?: string;
    version?: string;
  };
  const cliManifest = JSON.parse(await readFile(join(repository, "apps/cli/package.json"), "utf8")) as {
    name?: string;
    version?: string;
    private?: boolean;
    type?: string;
    exports?: Record<string, unknown>;
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const mcpManifest = JSON.parse(await readFile(join(repository, "apps/mcp-server/package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };

  assert.equal(cliManifest.name, "@framekit/cli");
  assert.match(cliManifest.version ?? "", /^\d+\.\d+\.\d+$/);
  assert.equal(cliManifest.private, true);
  assert.equal(cliManifest.type, "module");
  assert.deepEqual(cliManifest.exports, {});
  assert.deepEqual(cliManifest.dependencies, {
    "@framekit/final-cut": "workspace:*",
    "@framekit/headless-application": "workspace:*",
  });
  assert.equal(cliManifest.scripts?.start, "tsx src/main.ts");
  assert.equal(cliManifest.devDependencies?.tsx, "4.23.15");
  assert.equal(cliManifest.devDependencies?.typescript, "7.0.2");
  assert.equal(rootManifest.bin?.framekit, "./bin/framekit.mjs");
  assert.deepEqual(rootManifest.exports, { "./bin/framekit.mjs": "./bin/framekit.mjs" });
  assert.equal(rootManifest.main, undefined, "the implementation is not a root JavaScript API");
  assert.equal(mcpManifest.dependencies?.["@framekit/headless-application"], "workspace:*");
  assert.equal(Object.hasOwn(cliManifest.dependencies ?? {}, "@framekit/mcp-server"), false);
  assert.equal(Object.hasOwn(mcpManifest.dependencies ?? {}, "@framekit/cli"), false);
});

test("CLI workspace start script resolves its private app entrypoint", async () => {
  const { stdout } = await exec("pnpm", ["--filter", "@framekit/cli", "start", "--", "help"], {
    cwd: repository,
  });
  assert.match(stdout, /framekit mcp --editor final-cut-live \[--headless\]/);
});

test("CLI shared workflow composes into MCP without app-to-app dependencies", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-cli-mcp-workflow-"));
  const service = createCliHeadlessProjectService({ directory });
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "workspace-identity-project",
    projectName: "Workspace Identity",
    timelineId: "workspace-identity-sequence",
    timelineName: "Master",
    clips: [],
  }));
  const server = createMcpServer(runtime, { headlessProjects: service });
  const client = new Client({ name: "framekit-cli-mcp-workflow-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "headless.project.list", arguments: {} });
    assert.equal(result.isError, undefined);
    const content = (result as { content?: unknown }).content;
    assert.ok(Array.isArray(content));
    const first = content[0] as { type?: unknown; text?: unknown } | undefined;
    assert.equal(first?.type, "text");
    assert.deepEqual(JSON.parse(typeof first?.text === "string" ? first.text : "null"), []);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
