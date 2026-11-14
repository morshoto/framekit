import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const playbooks = {
  readme: [".agents/README.md", ["skills/issue-create/SKILL.md", "skills/issue-read/SKILL.md", "skills/review-pr/SKILL.md"]],
  issueCreate: [".agents/skills/issue-create/SKILL.md", ["name: issue-create", "gh issue create", "explicit approval", ".github/ISSUE_TEMPLATE"]],
  issueRead: [".agents/skills/issue-read/SKILL.md", ["name: issue-read", "gh issue view", "read-only", "recommended next action"]],
  reviewPr: [".agents/skills/review-pr/SKILL.md", ["name: review-pr", "gh pr diff", "REQUEST_CHANGES", "APPROVE", "git push", "existing review comment"]],
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

test("repository agent skills keep their helper scripts", async () => {
  for (const relativePath of [
    ".agents/skills/issue-create/scripts/create-issue.sh",
    ".agents/skills/issue-read/scripts/read-issue.sh",
    ".agents/skills/review-pr/scripts/collect-review.sh",
  ]) {
    const content = await readFile(resolve(relativePath), "utf8");
    assert.match(content, /^#!\/usr\/bin\/env bash/m);
  }
});
