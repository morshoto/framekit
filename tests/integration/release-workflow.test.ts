import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateReleaseContract } from "../../scripts/validate-release-contract.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const releaseConfigPath = resolve(repository, ".github/release.yml");

const expectedReleaseCategories = [
  { title: "✨ Features", labels: ["Type: New Feature"] },
  { title: "🐛 Fixes", labels: ["Problem: Bug"] },
  { title: "🧰 Maintenance & Internal", labels: ["*"] },
];

type ReleaseCategory = {
  title: string;
  labels: string[];
};

function parseReleaseCategories(config: string): ReleaseCategory[] {
  const categories: ReleaseCategory[] = [];
  let currentCategory: ReleaseCategory | undefined;

  for (const line of config.split(/\r?\n/)) {
    const title = line.match(/^ {4}- title: ["'](.+)["']$/)?.[1];
    if (title) {
      currentCategory = { title, labels: [] };
      categories.push(currentCategory);
      continue;
    }

    const label = line.match(/^ {8}- ["'](.+)["']$/)?.[1];
    if (label && currentCategory) currentCategory.labels.push(label);
  }

  return categories;
}

function parseExcludedLabels(config: string): string[] {
  const categoriesStart = config.indexOf("  categories:");
  const exclusions = categoriesStart === -1 ? config : config.slice(0, categoriesStart);

  return exclusions.split(/\r?\n/)
    .map((line) => line.match(/^ {6}- (.+)$/)?.[1])
    .filter((label): label is string => label !== undefined);
}

function categorizeRelease(labels: string[], categories: ReleaseCategory[]): string | undefined {
  return categories.find((category) => (
    category.labels.includes("*") || labels.some((label) => category.labels.includes(label))
  ))?.title;
}

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

test("release workflow gates publication on v0.1.6 evidence and native checksums", async () => {
  const workflow = await readFile(resolve(repository, ".github/workflows/release.yml"), "utf8");
  const nativePackaging = workflow.indexOf("native-release-assets:");
  const gate = workflow.indexOf("pnpm run release-gate --output-dir");
  const npmPublish = workflow.indexOf("npm publish --access public");
  const npmVerification = workflow.indexOf("name: Verify npm publication");
  const assetVerification = workflow.indexOf("name: Verify native release assets");
  const githubRelease = workflow.indexOf("name: Publish GitHub release");
  const finalProvenance = workflow.indexOf("name: Verify complete release provenance");

  assert.notEqual(gate, -1);
  assert.notEqual(nativePackaging, -1);
  assert.ok(gate < npmPublish, "release gate must run before npm publication");
  assert.match(
    workflow,
    /native-release-assets:[\s\S]*?runs-on:\s*\[self-hosted, macOS, framekit-release\][\s\S]*?scripts\/package-final-cut-release\.sh[\s\S]*?upload_url[\s\S]*?gh api --method POST/,
  );
  assert.notEqual(assetVerification, -1);
  assert.notEqual(npmVerification, -1);
  assert.ok(npmVerification < assetVerification, "native assets follow npm verification");
  assert.ok(assetVerification < githubRelease, "native assets must precede public release");
  assert.ok(githubRelease < finalProvenance, "complete provenance follows public release");
  assert.match(workflow, /FramekitFinalCutWorkflow-\$\{expected_version\}\.zip/);
  assert.match(workflow, /gh release download "\$\{RELEASE_TAG\}"/);
  assert.match(workflow, /shasum -a 256 -c/);
  assert.match(workflow, /pnpm run test:codex-plugin/);
  assert.match(workflow, /validate-codex-plugin:[\s\S]*?permissions:\s+contents: read[\s\S]*?pnpm install --frozen-lockfile[\s\S]*?pnpm run test:codex-plugin/);
  assert.match(workflow, /publish-npm:[\s\S]*?needs:\s*\n\s+- tagpr\n\s+- validate-codex-plugin/);
  assert.doesNotMatch(workflow, /npm install --global @openai\/codex/);
  assert.match(workflow, /RELEASE_PROVENANCE_OUTPUT_DIR: artifacts\/release-gate\/\$\{\{ github\.run_id \}\}/);
  assert.match(
    workflow,
    /publish-npm:[\s\S]*?needs:\s*\n\s+- tagpr\n\s+- validate-codex-plugin\n\s+- native-release-assets/,
  );
});

test("release workflow preflights the required native runner", async () => {
  const workflow = await readFile(resolve(repository, ".github/workflows/release.yml"), "utf8");
  const preflight = workflow.indexOf("release-runner-preflight:");
  const nativePackaging = workflow.indexOf("native-release-assets:");
  const publication = workflow.indexOf("publish-npm:");

  assert.notEqual(preflight, -1);
  assert.ok(preflight < nativePackaging, "runner preflight must precede native packaging");
  assert.ok(nativePackaging < publication, "native packaging must precede publication");

  const preflightJob = workflow.slice(preflight, nativePackaging);
  assert.match(preflightJob, /runs-on: ubuntu-latest/);
  assert.match(preflightJob, /actions: read/);
  assert.match(preflightJob, /actions\/checkout@(?:v7|[0-9a-f]{40}[ \t]+# v7)/);
  assert.match(preflightJob, /actions\/runners\?per_page=100/);
  assert.match(preflightJob, /gh api --paginate --slurp/);
  assert.match(preflightJob, /node scripts\/check-release-runner\.mjs/);

  const nativeJob = workflow.slice(nativePackaging, publication);
  assert.match(nativeJob, /needs:\s*\n\s+- tagpr\s*\n\s+- release-runner-preflight/);
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
  assert.match(statusStep, /npm view --prefer-online "\$\{package_name\}@\$\{expected_version\}" version/);
  assert.match(statusStep, /E404\|404 Not Found/);
  assert.match(statusStep, /published=true/);
  assert.match(statusStep, /published=false/);

  const publicationStep = workflow.slice(publication, verification);
  assert.match(publicationStep, /if: steps\.npm-status\.outputs\.published != 'true'/);
});

test("release verification retries transient npm registry visibility", async () => {
  const workflow = await readFile(resolve(repository, ".github/workflows/release.yml"), "utf8");
  const statusCheck = workflow.slice(
    workflow.indexOf("name: Check npm publication status"),
    workflow.indexOf("name: Publish npm package"),
  );
  const verification = workflow.slice(
    workflow.indexOf("name: Verify npm publication"),
    workflow.indexOf("name: Publish GitHub release"),
  );

  assert.match(statusCheck, /npm view --prefer-online "\$\{package_name\}@\$\{expected_version\}" version/);
  assert.match(verification, /max_attempts=6/);
  assert.match(verification, /for attempt in \$\(seq 1 "\$\{max_attempts\}"\)/);
  assert.match(verification, /npm view --prefer-online "\$\{package_name\}@\$\{expected_version\}" version/);
  assert.match(verification, /No match found for version/);
  assert.match(verification, /sleep "\$\{delay\}"/);
});

test("release retries tolerate a duplicate npm publish after a visibility race", async () => {
  const workflow = await readFile(resolve(repository, ".github/workflows/release.yml"), "utf8");
  const publication = workflow.indexOf("name: Publish npm package");
  const verification = workflow.indexOf("name: Verify npm publication");
  const publicationStep = workflow.slice(publication, verification);

  assert.match(publicationStep, /npm publish --access public/);
  assert.match(publicationStep, /EPUBLISHCONFLICT|previously published versions/);
  assert.match(publicationStep, /verification will confirm/i);
  assert.match(publicationStep, /exit 0/);
});

test("release workflow validates the built MCP server version before publishing", async () => {
  const workflow = await readFile(resolve(repository, ".github/workflows/release.yml"), "utf8");
  const build = workflow.indexOf("pnpm run build:package");
  const validation = workflow.indexOf("node scripts/validate-mcp-server-version.mjs");
  const publication = workflow.indexOf("npm publish");

  assert.notEqual(build, -1, "release workflow must build the package before MCP validation");
  assert.notEqual(validation, -1, "release workflow must validate MCP server provenance");
  assert.ok(build < validation, "MCP validation must inspect the built package");
  assert.ok(validation < publication, "MCP validation must run before npm publish");

  const documentation = await readFile(resolve(repository, "docs/releasing.md"), "utf8");
  assert.match(documentation, /node scripts\/validate-mcp-server-version\.mjs/);
});

test("release documentation provides the exact npm trust command", async () => {
  const documentation = await readFile(resolve(repository, "docs/releasing.md"), "utf8");
  assert.match(documentation, /npm trust github @morshoto\/framekit/);
  assert.match(documentation, /--repo\s+morshoto\/framekit/);
  assert.match(documentation, /--file\s+release\.yml/);
  assert.match(documentation, /--allow-publish/);
  assert.match(documentation, /--yes/);
});

test("release documentation explains native runner preflight recovery", async () => {
  const documentation = await readFile(resolve(repository, "docs/releasing.md"), "utf8");

  assert.match(documentation, /preflight/i);
  assert.match(documentation, /online and idle/i);
  assert.match(documentation, /self-hosted.*macOS.*framekit-release/s);
  assert.match(documentation, /RELEASE_RUNNER_UNAVAILABLE/);
  assert.match(documentation, /actions\/runners\?per_page=100/);
  assert.match(documentation, /retry the existing release tag/i);
});

test("release notes classify representative v0.1.7 changes by label", async () => {
  const config = await readFile(releaseConfigPath, "utf8");
  const categories = parseReleaseCategories(config);

  assert.deepEqual(categories, expectedReleaseCategories);

  const representativeChanges = [
    { pullRequest: 220, labels: ["Type: New Feature"], category: "✨ Features" },
    { pullRequest: 228, labels: ["Problem: Bug"], category: "🐛 Fixes" },
    { pullRequest: 226, labels: ["Type: Document"], category: "🧰 Maintenance & Internal" },
  ];

  for (const change of representativeChanges) {
    assert.equal(
      categorizeRelease(change.labels, categories),
      change.category,
      `PR #${change.pullRequest} should use its label category`,
    );
  }
});

test("release notes continue excluding Tag PRs", async () => {
  const config = await readFile(releaseConfigPath, "utf8");

  assert.deepEqual(parseExcludedLabels(config), ["tagpr"]);
});
