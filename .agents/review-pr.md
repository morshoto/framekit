# Review a pull request and remediate findings

Use this playbook to review a PR against its linked issue and repository
contracts. The workflow may fix validated findings, but it must never merge or
close the PR.

## Review inputs

Accept a PR number or URL. Read the current PR head; never rely on an old
local checkout.

```sh
gh pr view PR --json title,body,files,url,headRefName,baseRefName,headRefOid
gh pr diff PR
gh pr view PR --comments
gh api repos/OWNER/REPO/pulls/NUMBER/comments \
  --jq '.[] | {file: .path, user: .user.login, comment: .body, line: .line, side: .side}'
gh pr checks PR
```

## Review checklist

Review the change against the linked issue, `AGENTS.md`, runtime dependency
boundaries, public MCP schemas, capability flags, fail-closed behavior,
tests, documentation, compatibility claims, security, privacy, performance,
and required Final Cut validation.

Summarize each changed file by explaining the before/after behavior and
whether it serves the PR purpose. Classify findings as `blocker`, `required`,
`concern`, or `none`.

## Validate existing comments

For every existing review comment:

1. Check whether it still applies to the current PR head.
2. Confirm it against the current code and tests.
3. If valid and safely fixable, apply the fix below.
4. If valid but not safely fixable, keep or add a concise inline comment.
5. If invalid or outdated, reply to the thread with evidence explaining why
   no code change is needed.

Do not silently dismiss a review thread.

## Apply a validated fix

Only fix findings that are clearly in scope and supported by repository
evidence.

1. Confirm the current worktree is clean before any local mutation. If it is
   dirty, do not overwrite user changes.
2. Create an isolated worktree from the PR head rather than checking out the
   PR over the user's current branch.
3. Apply the smallest fix and add a regression test when behavior changes.
4. Run the required checks:

   ```sh
   pnpm install --frozen-lockfile
   pnpm run build
   pnpm run test
   pnpm run check:boundaries
   ```

   Run the native Xcode checks when native files changed.

5. Commit with a concise imperative message.
6. Push only to the PR's same-repository head branch after confirming the
   branch and commit target:

   ```sh
   git push origin HEAD:PR_HEAD_BRANCH
   ```

   If the PR is from a fork or push permission is unavailable, do not force a
   push; report the patch and leave the review comment instead.
7. Reply to the relevant review thread with the commit hash and validation
   evidence.
8. Refresh the PR checks before deciding the final review outcome.

## Review comments and final decision

Use short, polite comments with a severity prefix:

- `[must]` for a blocker or required fix;
- `[want]` for a non-blocking improvement;
- `[ask]` for clarification;
- `[info]` for evidence or context.

If blockers remain, submit a `REQUEST_CHANGES` review with the inline comments.
If no blockers remain and required checks pass, submit `APPROVE`. Do not
approve merely because CI is green when a correctness issue remains.

## Final report

Return the PR purpose and changed-file summary, CI and validation status,
findings and comment links, fixes pushed with commit hashes and test evidence,
the final review decision, and unresolved risks or follow-up work.
