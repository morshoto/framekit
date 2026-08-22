---
name: issue-read
description: Read and summarize a Framekit GitHub issue, its linked pull requests, comments, and current validation state without mutation.
---

# Read an issue

Use this skill for read-only issue status, planning, or evidence collection.
Require `OWNER/REPO` and an issue number or URL. Never edit, label, assign,
close, or comment on the issue.

## Workflow

1. Run the helper:

   ```sh
   .agents/skills/issue-read/scripts/read-issue.sh OWNER/REPO ISSUE_NUMBER_OR_URL
   ```

2. Inspect linked pull requests, review comments, and checks when present.
3. Report objective, acceptance criteria, current state, evidence, open
   blockers, and a recommended next action. Separate verified facts from
   assumptions and stale comments.

The helper is a convenience for collection; the final report must still use
the live issue and check state. Do not perform mutations as part of reading.
It wraps `gh issue view` with comments and structured issue metadata.
