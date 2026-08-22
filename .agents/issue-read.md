# Read a GitHub issue

Use this playbook for a read-only status report on an issue.

## Inputs

Accept an issue number or URL. If no issue is supplied, identify the current
repository with:

```sh
gh repo view --json nameWithOwner -q .nameWithOwner
```

## Workflow

1. Read the issue metadata, body, labels, comments, and state:

   ```sh
   gh issue view ISSUE --comments --json number,title,body,state,labels,assignees,milestone,comments,url
   ```

2. Inspect related pull requests and current checks when they are linked or
   discoverable from the issue timeline.

3. Read repository files only when needed to verify a claim in the issue. Use
   the issue body and live GitHub state as the primary sources of truth.

4. Report the objective, current state, acceptance criteria, completed
   evidence, linked PRs and CI status, unresolved questions, blockers, and
   recommended next action.

## Output rules

- Separate confirmed evidence from assumptions.
- Link directly to the issue, PRs, checks, and relevant repository files.
- Do not modify the issue, comments, labels, milestones, projects, or linked
  pull requests.
- Do not infer completion from an open PR alone; inspect its checks and review
  state.
