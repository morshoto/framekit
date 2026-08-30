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
