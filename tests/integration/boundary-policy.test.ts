import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeWorkspaceBoundaries } from "../../scripts/boundary-policy.mjs";

const packages = [
  { id: "runtime", name: "@fixture/runtime", root: "packages/runtime", manifest: "packages/runtime/package.json" },
  { id: "adapter", name: "@fixture/adapter", root: "adapters/native", manifest: "adapters/native/package.json" },
  { id: "server", name: "@fixture/server", root: "apps/server", manifest: "apps/server/package.json" },
];

const policy = {
  allowedDependencies: {
    runtime: [],
    adapter: ["runtime"],
    server: ["runtime", "adapter"],
  },
  allowedExternalDependencies: {
    runtime: [],
    adapter: [],
    server: [],
  },
  productionEntrypoints: ["apps/server/src/index.ts"],
  experimentalModules: ["adapters/native/src/experimental.ts"],
  exceptions: [],
};

test("resolves TypeScript aliases and relative imports into package-owned graph edges", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }));

  const result = await analyzeWorkspaceBoundaries({ ...fixture, packages, policy });

  assert.deepEqual(result.violations, []);
  assert.ok(result.edges.some((edge) => edge.source === "adapters/native/src/index.ts"
    && edge.target === "packages/runtime/src/index.ts"
    && edge.specifier === "@fixture/runtime"));
  assert.ok(result.edges.some((edge) => edge.source === "adapters/native/src/index.ts"
    && edge.target === "adapters/native/src/value.ts"
    && edge.specifier === "./value.js"));
});

test("rejects relative imports that cross package boundaries", async (t) => {
  const fixture = await createFixture({
    "packages/runtime/src/index.ts": 'import { nativeValue } from "../../../adapters/native/src/index.js"; export const runtimeValue = nativeValue;',
  });
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }));

  const result = await analyzeWorkspaceBoundaries({ ...fixture, packages, policy });

  assertViolation(result, "relative-cross-package");
});

test("rejects forbidden workspace dependencies reached through TypeScript aliases", async (t) => {
  const fixture = await createFixture({
    "packages/runtime/src/index.ts": 'import { nativeValue } from "@fixture/adapter"; export const runtimeValue = nativeValue;',
  });
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }));

  const result = await analyzeWorkspaceBoundaries({ ...fixture, packages, policy });

  assertViolation(result, "forbidden-dependency");
});

test("rejects source-level dependency cycles", async (t) => {
  const fixture = await createFixture({
    "packages/runtime/src/index.ts": 'import { cycleValue } from "./cycle.js"; export const runtimeValue = cycleValue;',
    "packages/runtime/src/cycle.ts": 'import { runtimeValue } from "./index.js"; export const cycleValue = runtimeValue;',
  });
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }));

  const result = await analyzeWorkspaceBoundaries({ ...fixture, packages, policy });

  assertViolation(result, "dependency-cycle");
});

test("rejects undeclared external packages", async (t) => {
  const fixture = await createFixture({
    "adapters/native/src/index.ts": 'import pad from "left-pad"; export const nativeValue = pad("x", 2);',
  });
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }));

  const result = await analyzeWorkspaceBoundaries({
    ...fixture,
    packages,
    policy: {
      ...policy,
      allowedExternalDependencies: { ...policy.allowedExternalDependencies, adapter: ["left-pad"] },
    },
  });

  assertViolation(result, "undeclared-dependency");
});

test("rejects external packages outside the owner's dependency matrix", async (t) => {
  const fixture = await createFixture({
    "packages/runtime/src/index.ts": 'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"; export const runtimeValue = McpServer;',
  });
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }));

  const result = await analyzeWorkspaceBoundaries({ ...fixture, packages, policy });

  assertViolation(result, "forbidden-external-dependency");
});

test("requires workspace package imports to be declared directly", async (t) => {
  const fixture = await createFixture({
    "apps/server/package.json": packageManifest("@fixture/server", { "@fixture/runtime": "workspace:*" }),
  });
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }));

  const result = await analyzeWorkspaceBoundaries({ ...fixture, packages, policy });

  assertViolation(result, "undeclared-dependency");
});

test("rejects imports outside a workspace package public export map", async (t) => {
  const fixture = await createFixture({
    "apps/server/src/index.ts": 'import { internalValue } from "@fixture/adapter/private.js"; export { internalValue };',
  });
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }));

  const result = await analyzeWorkspaceBoundaries({ ...fixture, packages, policy });

  assertViolation(result, "unexported-entrypoint");
});

test("resolves every wildcard in a package export target", async (t) => {
  const fixture = await createFixture({
    "packages/runtime/package.json": JSON.stringify({
      name: "@fixture/runtime",
      private: true,
      type: "module",
      exports: { ".": "./src/index.ts", "./features/*": "./src/features/*/index-*.ts" },
    }),
    "packages/runtime/src/features/example/index-example.ts": "export const feature = 1;",
    "apps/server/src/index.ts": 'import { feature } from "@fixture/runtime/features/example"; export const serverValue = feature;',
  });
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }));

  const result = await analyzeWorkspaceBoundaries({ ...fixture, packages, policy });

  assert.deepEqual(result.violations, []);
  assert.ok(result.edges.some((edge) => edge.target === "packages/runtime/src/features/example/index-example.ts"));
});

test("treats dollar sequences in wildcard captures as literal paths", async (t) => {
  const fixture = await createFixture({
    "tsconfig.json": JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: {
        "@fixture/runtime": ["./packages/runtime/src/index.ts"],
        "@fixture/runtime/features/*": ["./packages/runtime/src/features/*/index.ts"],
        "@fixture/adapter": ["./adapters/native/src/index.ts"],
      } },
    }),
    "packages/runtime/package.json": JSON.stringify({
      name: "@fixture/runtime",
      private: true,
      type: "module",
      exports: { ".": "./src/index.ts", "./features/*": "./src/features/*/index.ts" },
    }),
    "packages/runtime/src/features/name$&/index.ts": "export const feature = 1;",
    "apps/server/src/index.ts": 'import { feature } from "@fixture/runtime/features/name$&"; export const serverValue = feature;',
  });
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }));

  const result = await analyzeWorkspaceBoundaries({ ...fixture, packages, policy });

  assert.deepEqual(result.violations, []);
  assert.ok(result.edges.some((edge) => edge.target === "packages/runtime/src/features/name$&/index.ts"));
});

test("rejects experimental native modules in default production reachability", async (t) => {
  const fixture = await createFixture({
    "adapters/native/src/index.ts": 'export * from "./experimental.js"; export const nativeValue = true;',
    "adapters/native/src/experimental.ts": "export const experimentalNativeValue = true;",
  });
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }));

  const result = await analyzeWorkspaceBoundaries({ ...fixture, packages, policy });

  assertViolation(result, "experimental-production-import");
});

test("keeps the package-boundary gate in pull request CI", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/typescript.yml", import.meta.url), "utf8");
  assert.match(workflow, /Package boundary checks[\s\S]*?run: pnpm run check:boundaries/);
});

function assertViolation(result: { violations: Array<{ code: string }> }, code: string): void {
  assert.ok(result.violations.some((violation) => violation.code === code), `expected ${code}; got ${JSON.stringify(result.violations)}`);
}

async function createFixture(overrides: Record<string, string> = {}): Promise<{ rootDir: string }> {
  const rootDir = await mkdtemp(join(os.tmpdir(), "framekit-boundary-fixture-"));
  const files: Record<string, string> = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: {
          "@fixture/runtime": ["./packages/runtime/src/index.ts"],
          "@fixture/adapter": ["./adapters/native/src/index.ts"],
          "@fixture/server": ["./apps/server/src/index.ts"],
        },
      },
    }),
    "packages/runtime/package.json": packageManifest("@fixture/runtime", {}),
    "packages/runtime/src/index.ts": "export const runtimeValue = 1;",
    "adapters/native/package.json": packageManifest("@fixture/adapter", { "@fixture/runtime": "workspace:*" }),
    "adapters/native/src/index.ts": 'import { runtimeValue } from "@fixture/runtime"; import { localValue } from "./value.js"; export const nativeValue = runtimeValue + localValue;',
    "adapters/native/src/value.ts": "export const localValue = 1;",
    "apps/server/package.json": packageManifest("@fixture/server", {
      "@fixture/runtime": "workspace:*",
      "@fixture/adapter": "workspace:*",
    }),
    "apps/server/src/index.ts": 'import { runtimeValue } from "@fixture/runtime"; import { nativeValue } from "@fixture/adapter"; export const serverValue = runtimeValue + nativeValue;',
    ...overrides,
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = join(rootDir, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, "utf8");
  }
  return { rootDir };
}

function packageManifest(name: string, dependencies: Record<string, string>): string {
  return JSON.stringify({
    name,
    private: true,
    type: "module",
    exports: { ".": { types: "./src/index.ts", import: "./src/index.ts" } },
    dependencies,
  });
}
