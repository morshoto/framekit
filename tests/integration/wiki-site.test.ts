import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const repository = resolve(import.meta.dirname, "../..");
const webRoot = join(repository, "apps/web");

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

test("wiki content keeps product, learn, docs, and locale concerns explicit", async () => {
  for (const requiredPath of [
    "wiki/README.md",
    "wiki/_data/capabilities.json",
    "wiki/en/product/home.md",
    "wiki/en/use-cases/final-cut-pro-ai.md",
    "wiki/en/learn/final-cut-pro-ai.md",
    "wiki/en/docs/index.md",
    "wiki/en/blog/index.md",
    "wiki/ja/product/home.md",
    "wiki/ja/use-cases/final-cut-pro-ai.md",
    "wiki/ja/learn/final-cut-pro-ai.md",
    "wiki/ja/docs/index.md",
    "wiki/ja/blog/index.md",
  ]) {
    await access(join(repository, requiredPath));
  }

  const capabilities = await readJson<Array<{ status?: string; source?: string }>>(
    join(repository, "wiki/_data/capabilities.json"),
  );
  assert.ok(capabilities.length >= 3);
  assert.ok(capabilities.every(({ status }) =>
    ["available", "experimental", "coming-soon", "unavailable"].includes(status ?? "")
  ));
  assert.ok(capabilities.every(({ source }) => source?.startsWith("docs/")));

  for (const preservedPath of [
    "docs/COMPATIBILITY.md",
    "docs/final-cut/installation.md",
    "docs/mcp/tools.md",
    "docs/tests/test-matrix.md",
  ]) {
    await access(join(repository, preservedPath));
  }
});

test("web package builds a static Next.js site with lint, tests, and Storybook", async () => {
  const manifest = await readJson<{
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>(join(webRoot, "package.json"));

  assert.ok(manifest.dependencies?.next);
  assert.ok(manifest.dependencies?.react);
  assert.ok(manifest.devDependencies?.sass);
  assert.ok(manifest.devDependencies?.storybook);
  for (const script of ["build", "lint", "test", "storybook", "build-storybook"]) {
    assert.ok(manifest.scripts?.[script], `apps/web needs a ${script} script`);
  }

  const nextConfig = await readFile(join(webRoot, "next.config.ts"), "utf8");
  assert.match(nextConfig, /output:\s*["']export["']/);
  assert.match(nextConfig, /trailingSlash:\s*true/);

  const workflow = await readFile(join(repository, ".github/workflows/wiki.yml"), "utf8");
  for (const command of ["lint", "test", "build", "build-storybook"]) {
    assert.match(workflow, new RegExp(`pnpm --filter @framekit/web ${command}`));
  }
});

test("every web component owns its barrel, story, SCSS, implementation, and test", async () => {
  const componentsRoot = join(webRoot, "components");
  const componentDirectories = (await readdir(componentsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.ok(componentDirectories.length >= 5);
  for (const name of componentDirectories) {
    const files = new Set(await readdir(join(componentsRoot, name)));
    for (const expected of [
      "index.ts",
      `${name}.tsx`,
      `${name}.module.scss`,
      `${name}.stories.tsx`,
      `${name}.test.tsx`,
    ]) {
      assert.ok(files.has(expected), `${name} must contain ${expected}`);
    }
  }
});

test("English and Japanese routes expose discovery, use case, learn, docs, and blog pages", async () => {
  for (const requiredPath of [
    "app/page.tsx",
    "app/ja/page.tsx",
    "app/use-cases/final-cut-pro-ai/page.tsx",
    "app/ja/use-cases/final-cut-pro-ai/page.tsx",
    "app/learn/final-cut-pro-ai/page.tsx",
    "app/ja/learn/final-cut-pro-ai/page.tsx",
    "app/docs/page.tsx",
    "app/ja/docs/page.tsx",
    "app/blog/page.tsx",
    "app/ja/blog/page.tsx",
    "app/sitemap.ts",
    "app/robots.ts",
  ]) {
    await access(join(webRoot, requiredPath));
  }
});
