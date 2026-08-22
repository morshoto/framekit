---
name: issue-create
description: Draft and create GitHub issues from user requests using Framekit issue templates and approved metadata.
---

# Create an issue

Use this skill when a user asks to turn a request into one or more GitHub
issues. Keep the draft grounded in the user's facts and repository evidence.

## Before creating

1. Detect the repository with `gh repo view`.
2. Inspect `.github/ISSUE_TEMPLATE/` and choose `bug`, `feature`,
   `improvement`, or `design` when appropriate.
3. Use only facts supplied by the user or verified from the repository. Mark
   missing details as `Needs confirmation`; do not invent metadata.
4. For each issue, show the title, body, labels, milestone, assignee, and the
   equivalent command. Ask for explicit approval before creating anything.
   Batch requests require approval for the complete batch.

Labels are allowed only when the user requested them. Validate requested labels
against `.github/labels/labels.json` and the live repository label list.

The helper wraps `gh issue create` and passes the approved title, body, and
labels without adding inferred metadata.

## Create

After approval, use the deterministic helper:

```sh
.agents/skills/issue-create/scripts/create-issue.sh OWNER/REPO \
  "Issue title" /path/to/body.md [--label "Label name"]...
```

Report the created URL and metadata. Do not merge, close, assign, or add
unrequested labels.
