import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function readRepositoryFile(relativePath: string): Promise<string> {
  return readFile(resolve(repository, relativePath), "utf8");
}

test("CodeQL keeps default-branch runs from being cancelled", async () => {
  const workflow = await readRepositoryFile(".github/workflows/codeql.yml");

  assert.match(workflow, /push:\s+branches:\s+- main/);
  assert.match(workflow, /group:\s+codeql-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}/);
  assert.match(workflow, /cancel-in-progress:\s+\$\{\{ github\.event_name == 'pull_request' \}\}/);
});

test("CodeQL still supersedes obsolete pull-request runs", async () => {
  const workflow = await readRepositoryFile(".github/workflows/codeql.yml");

  assert.match(workflow, /pull_request:\s+branches:\s+- main/);
  assert.match(workflow, /types:\s+- opened\s+- synchronize\s+- reopened/);
  assert.match(workflow, /github\.event_name == 'pull_request'/);
});

test("CodeQL concurrency policy is documented for operators", async () => {
  const documentation = await readRepositoryFile("docs/ci/codeql.md");

  assert.match(documentation, /default-branch.*queue/i);
  assert.match(documentation, /pull-request.*cancel/i);
  assert.match(documentation, /one.*running.*one.*pending/i);
  assert.match(documentation, /code-scanning analyses API/i);
});
