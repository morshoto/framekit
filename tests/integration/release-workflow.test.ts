import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateReleaseContract } from "../../scripts/validate-release-contract.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const canonicalManifest = {
  name: "@morshoto/framekit",
  version: "0.1.1",
  private: false,
  repository: {
    type: "git",
    url: "https://github.com/morshoto/framekit.git",
  },
  publishConfig: {
    access: "public",
  },
};

test("release preflight accepts the canonical package and matching tag", () => {
  assert.doesNotThrow(() => validateReleaseContract({
    packageManifest: canonicalManifest,
    releaseTag: "v0.1.1",
    githubRepository: "morshoto/framekit",
  }));
});

test("release preflight rejects a tag that differs from package version", () => {
  assert.throws(
    () => validateReleaseContract({
      packageManifest: canonicalManifest,
      releaseTag: "v0.1.2",
      githubRepository: "morshoto/framekit",
    }),
    /version .* does not match release tag/i,
  );
});

test("release preflight rejects a package repository mismatch", () => {
  assert.throws(
    () => validateReleaseContract({
      packageManifest: {
        ...canonicalManifest,
        repository: {
          type: "git",
          url: "https://github.com/example/other-repo.git",
        },
      },
      releaseTag: "v0.1.1",
      githubRepository: "morshoto/framekit",
    }),
    /repository .* does not match/i,
  );
});

test("release preflight rejects a package that is not publicly publishable", () => {
  assert.throws(
    () => validateReleaseContract({
      packageManifest: {
        ...canonicalManifest,
        private: true,
        publishConfig: { access: "restricted" },
      },
      releaseTag: "v0.1.1",
      githubRepository: "morshoto/framekit",
    }),
    /public/i,
  );
});

test("release workflow validates the package before publishing", async () => {
  const workflow = await readFile(resolve(repository, ".github/workflows/release.yml"), "utf8");
  const validation = workflow.indexOf("node scripts/validate-release-contract.mjs");
  const publication = workflow.indexOf("npm publish");

  assert.notEqual(validation, -1);
  assert.ok(validation < publication, "release validation must run before npm publish");
  assert.match(workflow, /GITHUB_REPOSITORY: \$\{\{ github\.repository \}\}/);
  assert.match(workflow, /release-tag: \$\{\{ steps\.existing-tag\.outputs\.tag \|\| steps\.run-tagpr\.outputs\.tag \}\}/);
  const tagDetection = workflow.slice(
    workflow.indexOf("name: Detect release tag on HEAD"),
    workflow.indexOf("name: Run tagpr"),
  );
  assert.match(tagDetection, /git tag --points-at HEAD --list 'v\*'/);
  assert.match(tagDetection, /mapfile -t tags/);
  assert.match(tagDetection, /\$\{#tags\[@\]\} > 1/);
  assert.match(tagDetection, /Multiple release tags point to HEAD/);
  assert.doesNotMatch(tagDetection, /head -n 1/);
  assert.match(workflow, /if: steps\.existing-tag\.outputs\.tag == ''/);
  assert.match(
    workflow,
    /tagpr:[\s\S]*?actions\/checkout@v4[\s\S]*?token: \$\{\{ secrets\.TAGPR_TOKEN \}\}[\s\S]*?persist-credentials: false/,
  );
  assert.match(workflow, /RELEASE_TAG: \$\{\{ needs\.tagpr\.outputs\.release-tag \}\}/);
  assert.match(workflow, /releases\/\$\{release_id\}/);
});

test("release documentation provides the exact npm trust command", async () => {
  const documentation = await readFile(resolve(repository, "docs/releasing.md"), "utf8");
  assert.match(documentation, /npm trust github @morshoto\/framekit/);
  assert.match(documentation, /--repo\s+morshoto\/framekit/);
  assert.match(documentation, /--file\s+release\.yml/);
  assert.match(documentation, /--allow-publish/);
  assert.match(documentation, /--yes/);
});
