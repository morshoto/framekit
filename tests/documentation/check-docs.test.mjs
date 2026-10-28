import assert from "node:assert/strict";
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

test("internal link checks report missing files and fragments", () => {
  const files = new Map([
    ["README.md", "[Missing](docs/retired.md)\n[Anchor](docs/architecture.md#missing)"],
    ["docs/architecture.md", "# Current\n"],
  ]);

  assert.deepEqual(findBrokenMarkdownLinks(files), [
    "README.md:1 links to missing docs/retired.md",
    "README.md:2 links to missing heading #missing in docs/architecture.md",
  ]);
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
