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

test("development checkout launcher prefers source over a stale dist package", async () => {
  const launcher = await readFile(join(repository, "bin", "framekit.mjs"), "utf8");

  assert.match(launcher, /const development = existsSync\(developmentEntrypoint\);/);
  assert.match(launcher, /const packaged = !development && existsSync\(packagedEntrypoint\);/);
});

test("published package contains the runnable Framekit CLI and MCP sources", async () => {
  const manifest = JSON.parse(await readFile(resolve(repository, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
    private?: boolean;
    bin?: Record<string, string>;
    exports?: Record<string, unknown>;
    dependencies?: Record<string, string>;
    files?: string[];
    scripts?: Record<string, string>;
  };

  assert.equal(manifest.name, "@morshoto/framekit");
  assert.equal(manifest.private, false);
  assert.equal(manifest.bin?.framekit, "./bin/framekit.mjs");
  assert.deepEqual(manifest.exports, { "./bin/framekit.mjs": "./bin/framekit.mjs" });
  assert.equal(manifest.dependencies?.tsx, undefined, "published CLI must not depend on the development loader");
  assert.deepEqual(manifest.files, ["bin", "dist-package"]);
  assert.equal(manifest.scripts?.prepack, "pnpm run build:package");
  assert.match(manifest.scripts?.["build:package"] ?? "", /write-package-build-identity\.ts/);

  const { stdout } = await exec("npm", ["pack", "--dry-run", "--json"], { cwd: repository });
  const [packed] = JSON.parse(stdout) as Array<{ files: Array<{ path: string; mode: number }> }>;
  const paths = packed.files.map((file) => file.path);
  for (const requiredPath of [
    "bin/framekit.mjs",
    "dist-package/apps/cli/src/main.js",
    "dist-package/apps/mcp-server/src/main.js",
    "dist-package/apps/mcp-server/src/build-identity.json",
    "dist-package/apps/mcp-server/runtime/speech-analyzer-wrapper.mjs",
    "dist-package/apps/mcp-server/runtime/whisper-speech-backend.py",
    "dist-package/packages/runtime/src/index.js",
    "dist-package/adapters/final-cut/typescript/src/index.js",
  ]) {
    assert.ok(paths.includes(requiredPath), `${requiredPath} must be included in the npm package`);
  }
  for (const executable of [
    "dist-package/apps/mcp-server/runtime/speech-analyzer-wrapper.mjs",
    "dist-package/apps/mcp-server/runtime/whisper-speech-backend.py",
  ]) {
    const packedFile = packed.files.find(({ path }) => path === executable);
    assert.ok(packedFile && (packedFile.mode & 0o111) !== 0, `${executable} must remain executable in the package`);
  }
  assert.equal(paths.some((path) => path.startsWith("tests/")), false);
  assert.equal(paths.some((path) => path.startsWith("adapters/final-cut/swift-bridge/")), false);

  const identity = JSON.parse(await readFile(
    resolve(repository, "dist-package/apps/mcp-server/src/build-identity.json"),
    "utf8",
  )) as { version?: string; commit?: string };
  assert.equal(identity.version, manifest.version);
  assert.match(identity.commit ?? "", /^[0-9a-f]{40}$/);
});

test("clean local and global installs expose the supported CLI and MCP entrypoints", { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-package-smoke-"));
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;

  try {
    const { stdout } = await exec("npm", ["pack", "--json", "--pack-destination", directory], {
      cwd: repository,
    });
    const [packed] = JSON.parse(stdout) as Array<{ filename: string }>;
    const archive = join(directory, packed.filename);
    await exec("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", archive], { cwd: directory });
    const installedManifest = JSON.parse(
      await readFile(join(directory, "node_modules", "@morshoto", "framekit", "package.json"), "utf8"),
    ) as { version?: string };

    const executable = join(directory, "node_modules", ".bin", "framekit");
    const speechAnalyzer = join(
      directory,
      "node_modules",
      "@morshoto",
      "framekit",
      "dist-package",
      "apps",
      "mcp-server",
      "runtime",
      "speech-analyzer-wrapper.mjs",
    );
    const help = await exec(executable, ["help"], { cwd: directory });
    assert.match(help.stdout, /framekit mcp --editor final-cut-live \[--headless\]/);
    await assert.rejects(
      exec(speechAnalyzer, [], { cwd: directory, env: { ...process.env, FRAMEKIT_SPEECH_BACKEND: "" } }),
      (error: unknown) => error instanceof Error
        && (error as Error & { code?: number }).code === 78
        && /SPEECH_ANALYZER_SETUP_REQUIRED/.test((error as Error & { stderr?: string }).stderr ?? ""),
    );

    const globalPrefix = join(directory, "global");
    await exec("npm", ["install", "--global", "--prefix", globalPrefix, "--ignore-scripts", "--no-audit", "--no-fund", archive], { cwd: directory });
    const globalExecutable = join(globalPrefix, "bin", process.platform === "win32" ? "framekit.cmd" : "framekit");
    const globalHelp = await exec(globalExecutable, ["help"], { cwd: directory });
    assert.match(globalHelp.stdout, /framekit mcp --editor final-cut-live \[--headless\]/);

    await exec(process.execPath, [
      "--input-type=module",
      "--eval",
      "await import('@morshoto/framekit/bin/framekit.mjs')",
    ], { cwd: directory });

    const privateSubpath = await exec(process.execPath, [
      "--input-type=module",
      "--eval",
      "await import('@morshoto/framekit/dist-package/apps/cli/src/main.js')",
    ], { cwd: directory }).then(
      () => undefined,
      (error: unknown) => error as { stderr?: string; code?: number },
    );
    assert.ok(privateSubpath);
    assert.match(privateSubpath.stderr ?? "", /ERR_PACKAGE_PATH_NOT_EXPORTED/);

    transport = new StdioClientTransport({
      command: executable,
      args: ["mcp", "--editor", "final-cut-live", "--headless"],
      cwd: directory,
      env: { ...process.env, FRAMEKIT_STATE_DIR: join(directory, "framekit-state"), FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0" },
      stderr: "pipe",
    });
    client = new Client({ name: "framekit-package-smoke", version: "0.1.0" });
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, installedManifest.version);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "connection.status"));
    assert.ok(tools.tools.some((tool) => tool.name === "editor.live.inspect"));
  } finally {
    await client?.close();
    await transport?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
