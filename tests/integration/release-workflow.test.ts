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
  assert.match(
    workflow,
    /release-tag: \$\{\{ steps\.requested-tag\.outputs\.tag \|\| steps\.existing-tag\.outputs\.tag \|\| steps\.run-tagpr\.outputs\.tag \}\}/,
  );
  const tagDetection = workflow.slice(
    workflow.indexOf("name: Detect release tag on HEAD"),
    workflow.indexOf("name: Run tagpr"),
  );
  assert.match(tagDetection, /git tag --points-at HEAD --list 'v\*'/);
  assert.match(tagDetection, /mapfile -t tags/);
  assert.match(tagDetection, /\$\{#tags\[@\]\} > 1/);
  assert.match(tagDetection, /Multiple release tags point to HEAD/);
  assert.doesNotMatch(tagDetection, /head -n 1/);
  assert.match(workflow, /if: steps\.requested-tag\.outputs\.tag == ''/);
  assert.match(
    workflow,
    /tagpr:[\s\S]*?actions\/checkout@(?:v7|[0-9a-f]{40}[ \t]+# v7)[\s\S]*?token: \$\{\{ secrets\.TAGPR_TOKEN \}\}[\s\S]*?persist-credentials: false/,
  );
  assert.match(workflow, /RELEASE_TAG: \$\{\{ needs\.tagpr\.outputs\.release-tag \}\}/);
  assert.match(workflow, /releases\/\$\{release_id\}/);
});

test("release workflow can retry an exact existing tag", async () => {
  const workflow = await readFile(resolve(repository, ".github/workflows/release.yml"), "utf8");

  assert.match(
    workflow,
    /workflow_dispatch:[\s\S]*?release_tag:[\s\S]*?required: true[\s\S]*?type: string/,
  );

  const requestedTag = workflow.slice(
    workflow.indexOf("name: Resolve requested release tag"),
    workflow.indexOf("name: Detect release tag on HEAD"),
  );
  assert.match(workflow, /concurrency:\s+group: release\s+cancel-in-progress: false/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(requestedTag, /REQUESTED_TAG: \$\{\{ inputs\.release_tag \}\}/);
  assert.match(requestedTag, /refs\/tags\/\$\{REQUESTED_TAG\}\^\{commit\}/);
  assert.match(
    requestedTag,
    /git merge-base --is-ancestor "refs\/tags\/\$\{REQUESTED_TAG\}\^\{commit\}" origin\/main/,
  );
  assert.match(requestedTag, /Requested release tag is not reachable from main/);
  assert.match(requestedTag, /tag=\$\{REQUESTED_TAG\}/);
  assert.match(
    workflow,
    /if: steps\.requested-tag\.outputs\.tag == '' && steps\.existing-tag\.outputs\.tag == ''/,
  );

  const publishJob = workflow.slice(workflow.indexOf("publish-npm:"));
  assert.match(
    publishJob,
    /name: Check out repository[\s\S]*?ref: \$\{\{ needs\.tagpr\.outputs\.release-tag \}\}/,
  );
});

test("release retries do not republish an existing npm version", async () => {
  const workflow = await readFile(resolve(repository, ".github/workflows/release.yml"), "utf8");
  const statusCheck = workflow.indexOf("name: Check npm publication status");
  const publication = workflow.indexOf("name: Publish npm package");
  const verification = workflow.indexOf("name: Verify npm publication");

  assert.notEqual(statusCheck, -1);
  assert.ok(statusCheck < publication, "npm status must be checked before publishing");
  assert.ok(publication < verification, "npm publication must precede verification");

  const statusStep = workflow.slice(workflow.lastIndexOf("- id: npm-status", statusCheck), publication);
  assert.match(statusStep, /id: npm-status/);
  assert.match(statusStep, /npm view "\$\{package_name\}@\$\{expected_version\}" version/);
  assert.match(statusStep, /E404\|404 Not Found/);
  assert.match(statusStep, /published=true/);
  assert.match(statusStep, /published=false/);

  const publicationStep = workflow.slice(publication, verification);
  assert.match(publicationStep, /if: steps\.npm-status\.outputs\.published != 'true'/);
});

test("release documentation provides the exact npm trust command", async () => {
  const documentation = await readFile(resolve(repository, "docs/releasing.md"), "utf8");
  assert.match(documentation, /npm trust github @morshoto\/framekit/);
  assert.match(documentation, /--repo\s+morshoto\/framekit/);
  assert.match(documentation, /--file\s+release\.yml/);
  assert.match(documentation, /--allow-publish/);
  assert.match(documentation, /--yes/);
});
