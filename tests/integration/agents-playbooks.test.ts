import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const playbooks = {
  readme: [".agents/README.md", ["issue-create.md", "issue-read.md", "review-pr.md"]],
  issueCreate: [".agents/issue-create.md", ["gh issue create", "explicit approval", ".github/ISSUE_TEMPLATE"]],
  issueRead: [".agents/issue-read.md", ["gh issue view", "read-only", "recommended next action"]],
  reviewPr: [".agents/review-pr.md", ["gh pr diff", "REQUEST_CHANGES", "APPROVE", "git push", "existing review comment"]],
} as const;

for (const [name, [relativePath, requiredText]] of Object.entries(playbooks)) {
  test(`repository agent playbook ${name} is present and governed`, async () => {
    const content = await readFile(resolve(relativePath), "utf8");
    for (const expected of requiredText) {
      assert.match(content, new RegExp(escapeRegExp(expected), "i"));
    }
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
