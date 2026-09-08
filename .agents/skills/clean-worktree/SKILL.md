---
name: clean-worktree
description: Inspect and safely clean a Framekit Git worktree by restoring only explicitly approved tracked paths, preserving untracked and unrelated files, and reporting upstream divergence separately from worktree dirtiness. Use when the user asks to make the workspace clean, discard inspected local edits, or confirm that a worktree is clean.
---

# Clean a Framekit worktree

Inspect before changing anything:

```sh
.agents/skills/clean-worktree/scripts/inspect-worktree.sh /path/to/worktree
```

Explain tracked, staged, and untracked changes. Identify which changes were created during the current task and which may belong to the user. A branch that is ahead or behind can still have a clean worktree; report divergence separately.

After the user authorizes discarding the inspected tracked paths, restore only the explicit list:

```sh
.agents/skills/clean-worktree/scripts/restore-listed.sh /path/to/worktree -- path/to/file ...
```

The helper refuses absolute paths, parent traversal, untracked paths, and broad implicit cleanup. Never use `git clean`, recursive deletion, `git reset --hard`, or restore unrelated paths. Handle untracked files only with separate, explicit user authorization and a recoverable operation where possible.

Run the inspector again and report both worktree status and upstream divergence.
