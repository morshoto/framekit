---
name: deliver-issue
description: Deliver a Framekit GitHub issue end to end with live issue inspection, an isolated worktree, test-first incremental commits, repository validation, non-draft PR creation, and remote CI follow-through. Use when the user asks to implement an issue, implement a proposed plan, make commits at each step, or finish by creating a PR.
---

# Deliver a Framekit issue

Treat delivery as complete only when the requested external state is verified. Do not stop at a plan, local patch, or local green test when the user requested a PR.

## Collect live context

Run:

```sh
.agents/skills/deliver-issue/scripts/collect-delivery-context.sh OWNER/REPO ISSUE
```

Read `AGENTS.md`, the issue body and comments, linked PRs, current acceptance criteria, and relevant repository contracts. Re-check live state even when prior context names an older branch or result.

## Plan and isolate

1. Translate every acceptance criterion into a test or explicit verification item.
2. Inspect existing worktrees and branches before creating anything.
3. Use an isolated worktree. Prefer `../codex-ws-ISSUE` when available and a `feat/`, `fix/`, or `perf/` branch matching the change.
4. Preserve unrelated edits. Never reset or clean another worktree.

## Implement incrementally

Use Red-Green-Refactor:

1. Add a focused failing test and confirm the expected failure.
2. Implement the smallest behavior that passes it.
3. Refactor without changing behavior.
4. Validate the focused seam after each step.

When the user asks for a commit at every step, create short reviewable commits. Use `update:` messages under eight words when requested. A deliberately red checkpoint may bypass a hook only after the focused failure is captured and explained.

## Validate and deliver

1. Invoke `$validate-framekit`; include native gates when native files changed.
2. Inspect the complete diff and confirm documentation and MCP contracts remain aligned.
3. Push the delivery branch and create a non-draft PR from the repository template.
4. Link the issue and map the PR evidence to its acceptance criteria.
5. Wait for relevant remote checks, inspect failures, and re-check the PR head SHA and mergeability.

Do not merge or close the issue unless the user explicitly requests it. Report commit hashes, validation evidence, PR URL, current checks, and any headed-native or external-state limitation.
