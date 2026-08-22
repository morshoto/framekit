---
name: review-pr
description: Review a pull request against its linked issue, validate findings, apply safe fixes, and record the final review decision.
---

# Review a pull request

Use this skill for a complete, evidence-based review. Never merge or close a
pull request. Start with the helper:

```sh
.agents/skills/review-pr/scripts/collect-review.sh OWNER/REPO PR_NUMBER
```

## Review scope

Review the live PR metadata, diff, conversation, inline comments, checks, and
linked issue against `AGENTS.md`. Check runtime/adapter boundaries, MCP schemas
and capability flags, fail-closed behavior, tests, documentation, security,
privacy, performance, and Final Cut/native constraints where relevant.

The helper collects the same evidence as `gh pr diff`, `gh pr view`,
`gh api .../pulls/.../comments`, and `gh pr checks`.

Validate each existing review comment and finding against the current PR head. Classify comments as
`[must]`, `[want]`, `[ask]`, or `[info]`; do not repeat resolved or outdated
findings without explaining the evidence.

## Fix and decide

If a finding is valid and safely fixable:

1. Confirm the current worktree is clean.
2. Use an isolated worktree from the PR head.
3. Apply the smallest fix and regression test.
4. Run the required repository checks; run native checks for native changes.
5. Commit and push only to the same-repository PR head branch with
   `git push origin HEAD:PR_HEAD_BRANCH`.
6. Reply to the relevant review thread with the fix and validation evidence.

If the PR is from a fork or cannot be safely changed, explain the blocker and
post a focused review comment instead. Request changes for any blocking issue;
approve only when no blockers remain and the relevant checks pass. Record the
final GitHub review as `REQUEST_CHANGES` for blockers or `APPROVE` when the PR
is ready. Never infer approval from an incomplete or unavailable check.
