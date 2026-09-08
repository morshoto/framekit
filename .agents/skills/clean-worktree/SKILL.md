---
name: clean-worktree
description: Inspect and safely clean a Framekit Git worktree by restoring only explicitly approved tracked paths, preserving untracked and unrelated files, and reporting upstream divergence separately from worktree dirtiness. Use when the user asks to make the workspace clean, discard inspected local edits, or confirm that a worktree is clean.
---

# Clean a Framekit worktree

Inspect before changing anything. When cleanup may follow, write a content-bound authorization manifest to a new path:

```sh
manifest="${TMPDIR:-/tmp}/framekit-clean-worktree-$$.tsv"
.agents/skills/clean-worktree/scripts/inspect-worktree.sh /path/to/worktree --manifest "$manifest"
```

Explain tracked, staged, and untracked changes. Identify which changes were created during the current task and which may belong to the user. Record the manifest path with the authorization request. A branch that is ahead or behind can still have a clean worktree; report divergence separately.

After the user authorizes discarding the inspected tracked paths, restore only the explicit list:

```sh
.agents/skills/clean-worktree/scripts/restore-listed.sh /path/to/worktree --manifest "$manifest" -- path/to/file ...
```

The helper refuses absolute paths, parent traversal, untracked paths, broad implicit cleanup, changed content, or a changed `HEAD`. It serializes its own restore operations and saves staged and worktree patches under the worktree Git directory before restoring. Report that backup path and recovery command. Never use `git clean`, recursive deletion, `git reset --hard`, or restore unrelated paths. Handle untracked files only with separate, explicit user authorization and a recoverable operation where possible.

Run the inspector again and report both worktree status and upstream divergence.
