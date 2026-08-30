import assert from "node:assert/strict";
import test from "node:test";

const validatorModulePath = "../../scripts/validate-release-contract.mjs";

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
