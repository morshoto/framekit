# Create a GitHub issue

Use this playbook when the user explicitly asks to create an issue in the
current repository.

## Safety gate

Issue creation is an external mutation. Always draft the issue first and ask
for explicit approval before running `gh issue create`. For a batch, show the
complete batch and require approval for the complete batch.

Create one issue per user request unless the user explicitly asks for a batch.
Do not split one request into multiple issues without approval.

## Workflow

1. Confirm the repository:

   ```sh
   gh repo view --json nameWithOwner -q .nameWithOwner
   ```

2. Inspect the available templates:

   ```sh
   find .github/ISSUE_TEMPLATE -maxdepth 1 -type f -print | sort
   ```

3. Select exactly one template:

   - bug or regression → `bug.md`;
   - feature or capability → `feature.md`;
   - reliability, UX, testing, or documentation improvement → `improvement.md`;
   - architecture or workflow proposal → `design.md`.

4. Draft the title and body using only facts supplied by the user. Preserve
   the selected template headings and write `Needs confirmation` where a
   required detail is missing.

5. Present the draft with the repository, template, title, body, metadata, and
   close-equivalent `gh issue create` command.

6. After approval, validate explicitly requested labels against both
   `.github/labels/labels.json` and GitHub:

   ```sh
   gh label list --limit 200
   ```

   Do not add labels merely because a template has a default. Labels may be
   selected from `.github/labels` only when the user asks for labels or asks
   the agent to choose them.

7. Prefer a body file for creation:

   ```sh
   gh issue create \
     --repo OWNER/REPO \
     --title "..." \
     --body-file /path/to/body.md
   ```

   Add only approved labels or other metadata.

8. Return the created issue URL and the metadata that was applied.

## Content rules

- Do not infer a root cause, affected file, reproduction step, or acceptance
  criterion that the user did not provide.
- Do not add milestones, assignees, projects, or labels without explicit
  permission.
- Do not claim the issue was created if GitHub or authentication fails.
- If creation fails, return the draft and the exact command that can be rerun.
