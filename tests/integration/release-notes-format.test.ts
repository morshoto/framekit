import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  collapseMaintenanceReleaseNotes,
  MAINTENANCE_RELEASE_SUMMARY,
} from "../../scripts/format-release-notes.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("collapses maintenance release notes without hiding user-facing sections", () => {
  const source = `## What's Changed
### ✨ Features
* feat: add something
### 🐛 Fixes
* fix: repair something
### 🧰 Maintenance & Internal
* chore: update tooling
* test: expand coverage

**Full Changelog**: https://github.com/example/repo/compare/v0.1.7...v0.1.8`;

  const formatted = collapseMaintenanceReleaseNotes(source);

  assert.match(formatted, /### ✨ Features\n\* feat: add something/);
  assert.match(formatted, /### 🐛 Fixes\n\* fix: repair something/);
  assert.match(
    formatted,
    new RegExp(`<details>\\n<summary>${MAINTENANCE_RELEASE_SUMMARY}</summary>\\n\\n\\* chore: update tooling\\n\\* test: expand coverage\\n\\n</details>`),
  );
  assert.match(formatted, /<\/details>\n\n\*\*Full Changelog\*\*:/);
  assert.doesNotMatch(formatted, /### 🧰 Maintenance & Internal/);
});

test("keeps following generated sections outside the maintenance details block", () => {
  const source = `## What's Changed
### 🧰 Maintenance & Internal
* chore: update tooling

## New Contributors
* @contributor made their first contribution

**Full Changelog**: https://github.com/example/repo/compare/v0.1.7...v0.1.8`;

  const formatted = collapseMaintenanceReleaseNotes(source);
  const detailsEnd = formatted.indexOf("</details>");
  const contributors = formatted.indexOf("## New Contributors");

  assert.ok(detailsEnd !== -1);
  assert.ok(contributors > detailsEnd, "New Contributors must remain outside the collapsed maintenance section");
});

test("release note formatting is idempotent", () => {
  const source = `## What's Changed
### 🧰 Maintenance & Internal
* chore: update tooling

**Full Changelog**: https://github.com/example/repo/compare/v0.1.7...v0.1.8`;

  const once = collapseMaintenanceReleaseNotes(source);
  assert.equal(collapseMaintenanceReleaseNotes(once), once);
});

test("leaves release notes without maintenance changes untouched", () => {
  const source = `## What's Changed
### ✨ Features
* feat: add something

**Full Changelog**: https://github.com/example/repo/compare/v0.1.7...v0.1.8`;

  assert.equal(collapseMaintenanceReleaseNotes(source), source);
});

test("format workflow targets Tag PRs and published GitHub releases", async () => {
  const workflow = await readFile(
    resolve(repository, ".github/workflows/format-release-notes.yml"),
    "utf8",
  );

  assert.match(workflow, /pull_request:\s*\n\s+types: \[opened, synchronize, reopened\]/);
  assert.match(workflow, /release:\s*\n\s+types: \[published\]/);
  assert.match(workflow, /startsWith\(github\.head_ref, 'tagpr-from-'\)/);
  assert.match(workflow, /pull-requests: write/);
  assert.match(workflow, /github-release:[\s\S]*?contents: write/);
  assert.equal(
    workflow.match(/node scripts\/format-release-notes\.mjs/g)?.length,
    2,
    "the same formatter should be used for the release PR and final release",
  );
});
