import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const validatorModulePath = "../../scripts/validate-release-contract.mjs";
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

test("release preflight accepts the canonical package and matching tag", async () => {
  const { validateReleaseContract } = await import(validatorModulePath);
  assert.doesNotThrow(() => validateReleaseContract({
    packageManifest: canonicalManifest,
    releaseTag: "v0.1.1",
    githubRepository: "morshoto/framekit",
  }));
});

test("release preflight rejects a tag that differs from package version", async () => {
  const { validateReleaseContract } = await import(validatorModulePath);
  assert.throws(
    () => validateReleaseContract({
      packageManifest: canonicalManifest,
      releaseTag: "v0.1.2",
      githubRepository: "morshoto/framekit",
    }),
    /version .* does not match release tag/i,
  );
});

test("release preflight rejects a package repository mismatch", async () => {
  const { validateReleaseContract } = await import(validatorModulePath);
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

test("release preflight rejects a package that is not publicly publishable", async () => {
  const { validateReleaseContract } = await import(validatorModulePath);
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
  assert.match(workflow, /RELEASE_TAG: \$\{\{ needs\.tagpr\.outputs\.tagpr-tag \}\}/);
});

test("release documentation provides the exact npm trust command", async () => {
  const documentation = await readFile(resolve(repository, "docs/releasing.md"), "utf8");
  assert.match(documentation, /npm trust github @morshoto\/framekit/);
  assert.match(documentation, /--repo\s+morshoto\/framekit/);
  assert.match(documentation, /--file\s+release\.yml/);
  assert.match(documentation, /--allow-publish/);
  assert.match(documentation, /--yes/);
});
