import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  CANONICAL_DOCS,
  findBrokenMarkdownLinks,
  findNonCanonicalDocs,
} from "../../scripts/check-docs.mjs";

test("the docs allowlist contains the five canonical documents", () => {
  assert.deepEqual(CANONICAL_DOCS, [
    "docs/README.md",
    "docs/architecture.md",
    "docs/getting-started.md",
    "docs/testing.md",
    "docs/release.md",
  ]);
});

test("the docs tree rejects retired files and directories", () => {
  assert.deepEqual(
    findNonCanonicalDocs([
      ...CANONICAL_DOCS,
      "docs/adr/0001-decision.md",
      "docs/legacy/",
    ]),
    ["docs/adr/0001-decision.md", "docs/legacy/"],
  );
});

test("internal links resolve paths, directories, and heading fragments", () => {
  const files = new Map([
    ["README.md", "# Project\n\n[Architecture](docs/architecture.md#boundaries)"],
    ["docs/README.md", "# Docs\n"],
    ["docs/architecture.md", "# Boundaries\n\n[Docs](./)"],
  ]);

  assert.deepEqual(findBrokenMarkdownLinks(files), []);
});

test("heading fragments retain inline code but ignore fenced examples", () => {
  const files = new Map([
    ["README.md", "[Tests](docs/testing.md#run-pnpm-run-test)\n[Example](docs/testing.md#hidden-example)"],
    ["docs/testing.md", "# Run `pnpm run test`\n\n```md\n# Hidden example\n```\n"],
  ]);

  assert.deepEqual(findBrokenMarkdownLinks(files), [
    "README.md:2 links to missing heading #hidden-example in docs/testing.md",
  ]);
});

test("internal link checks report missing files and fragments", () => {
  const files = new Map([
    ["README.md", "[Missing](docs/retired.md)\n[Anchor](docs/architecture.md#missing)"],
    ["docs/architecture.md", "# Current\n"],
  ]);

  assert.deepEqual(findBrokenMarkdownLinks(files), [
    "README.md:1 links to missing target docs/retired.md",
    "README.md:2 links to missing heading #missing in docs/architecture.md",
  ]);
});

test("internal links can target tracked assets and directories", () => {
  const files = new Map([[
    "README.md",
    "[Image](assets/framekit.png)\n[Examples](docs/examples/)",
  ]]);

  assert.deepEqual(
    findBrokenMarkdownLinks(files, ["README.md", "assets/framekit.png", "docs/examples/demo.md"]),
    [],
  );
});

test("link checks ignore code examples and external URLs", () => {
  const files = new Map([
    [
      "README.md",
      [
        "[External](https://example.com/retired.md)",
        "`[inline](docs/missing.md)`",
        "```md",
        "[example](docs/missing.md)",
        "```",
      ].join("\n"),
    ],
  ]);

  assert.deepEqual(findBrokenMarkdownLinks(files), []);
});

test("canonical docs retain architecture and safety boundaries", async () => {
  const architecture = await readFile(resolve("docs/architecture.md"), "utf8");

  for (const requirement of [
    "packages/runtime",
    "apps/mcp-server",
    "Timeline IR",
    "TimelineTarget",
    "frameDuration",
    "read-after-write",
    "provider and backend provenance",
    "metadata-only",
    "canonical timeline",
    "fail closed",
    "EditingSession",
    "headed-native fallback",
    "exact-target readback",
    "Undo",
    "FCPXML editing is an explicit artifact operation",
  ]) {
    const pattern = requirement
      .split(/\s+/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+");
    assert.match(architecture, new RegExp(pattern, "i"));
  }
});

test("canonical docs keep setup, test, and release commands discoverable", async () => {
  const [gettingStarted, testing, release] = await Promise.all([
    readFile(resolve("docs/getting-started.md"), "utf8"),
    readFile(resolve("docs/testing.md"), "utf8"),
    readFile(resolve("docs/release.md"), "utf8"),
  ]);

  assert.match(gettingStarted, /codex plugin marketplace add morshoto\/framekit/);
  assert.match(gettingStarted, /FRAMEKIT_EDITOR/);
  assert.match(gettingStarted, /FRAMEKIT_FCPXML_PATH/);
  assert.match(gettingStarted, /FRAMEKIT_FINAL_CUT_SOCKET/);
  assert.match(gettingStarted, /^### Optional analysis providers$/m);
  assert.match(testing, /pnpm run check:docs/);
  assert.match(testing, /deterministic[\s\S]*FCPXML artifact[\s\S]*metadata-only[\s\S]*canonical-live[\s\S]*headed-native/i);
  assert.match(testing, /does not run headed UI mutations by default/i);
  assert.match(release, /Trusted Publishing/);
  assert.match(release, /checksum/);
  assert.match(release, /verify-release-provenance/);
});
