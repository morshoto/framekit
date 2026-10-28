# Project status labels

The Framekit repository's `Status:` issue labels are the source of truth for the
Status field in [the Framekit project](https://github.com/users/morshoto/projects/3).
The `Sync project status from issue labels` workflow applies a status label to
the matching project field when an issue is opened, reopened, closed, or has a
status label added or removed. New issues start in Backlog. Closing an issue
sets Done; reopening it resets it to Backlog. Removing an issue's only status
label restores `Status: Backlog` and sets the project Status field to Backlog.

The workflow only synchronizes issues from `morshoto/framekit` that belong to
the project. Pull request cards are ignored. The project auto-add workflow may
remain enabled; the sync workflow also adds a newly opened issue if the
auto-add workflow has not added it yet.

The project's **Item added to project** and **Pull request linked to issue**
workflows are disabled because they can overwrite label-driven statuses.
**Auto-close issue** remains enabled so setting Status to Done closes the issue.

## Setup

1. Create a dedicated GitHub personal access token (classic) with `repo` and
   `project` scopes, then save it as the repository Actions secret
   `FRAMEKIT_PROJECT_TOKEN`. GitHub's built-in `GITHUB_TOKEN` cannot access
   Projects.
2. In the project Workflows settings, keep **Item added to project** and
   **Pull request linked to issue** disabled. Keep **Auto-close issue** enabled
   if setting Status to Done should close the issue.
3. Run **Sync project status from issue labels** with **Run workflow** to seed
   labels for project issues that do not already have one.

For each issue, an existing single status label takes priority during the
backfill. Issues without a status label receive the label matching their
current project Status. Items with multiple status labels are left unchanged
and reported as conflicts; remove all but the intended label, then rerun the
backfill. Items whose current Status is empty receive `Status: Backlog`.

If the token secret is absent, event-triggered runs report a warning and skip
the sync. The backfill must be rerun after the secret is configured.
