---
name: repair-pr-conflict
description: Repair merge conflicts on an existing Framekit pull request in place while preserving both additive behaviors, validating the resolved branch, pushing to the same PR head, and rechecking checks and mergeability. Use when the user says fix conflict, another PR merged, resolve and push, or asks to make an active PR mergeable again.
---

# Repair a PR conflict

Collect current evidence before touching the branch:

```sh
.agents/skills/repair-pr-conflict/scripts/collect-conflict-context.sh OWNER/REPO PR_NUMBER
```

## Resolve safely

1. Confirm the live PR head SHA, head branch, base branch, repository ownership, and conflict state.
2. Locate the existing PR worktree or create an isolated worktree from the exact head. Never reset another worktree.
3. Fetch the current base and integrate it into the active PR branch.
4. Resolve files semantically. Preserve compatible APIs, capability fields, tests, and fail-closed behavior from both sides.
5. Inspect the resolved diff for accidental deletion, duplicate implementations, weakened assertions, or generated artifacts.
6. Invoke `$validate-framekit`; include native gates when required.
7. Commit the conflict repair and push to the same PR head branch when authorized.
8. Re-run the collector and verify the new head SHA, mergeability, and remote checks.

Do not abandon, recreate, force-push, merge, or close the PR unless explicitly requested. If the PR comes from a fork or the head branch cannot be changed safely, report the permission boundary.
