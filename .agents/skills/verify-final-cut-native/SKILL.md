---
name: verify-final-cut-native
description: Safely preflight and verify real headed Final Cut Pro reads, edits, placement, revision changes, and Undo restoration using Framekit's headed runners. Use when the user asks for actual Final Cut timeline proof, native verification, a step-by-step headed test, or confirmation beyond fixtures, FCPXML, discovery, or metadata-only bridge behavior.
---

# Verify headed Final Cut behavior

Use a disposable project and prepared media. Native writes require an unlocked macOS console, frontmost Final Cut timeline, Accessibility and Automation permissions, and explicit mutation consent.

## Preflight

List supported modes and required variables:

```sh
.agents/skills/verify-final-cut-native/scripts/run-headed-check.sh --help
```

Run without `--execute` first. The helper checks the environment but does not run the headed scenario:

```sh
.agents/skills/verify-final-cut-native/scripts/run-headed-check.sh MODE
```

For a write scenario, require the user-authorized disposable target and set `FRAMEKIT_FINAL_CUT_E2E_ALLOW_MUTATION=1`. Then rerun with `--execute`.

## Proof contract

Capture and report each applicable invariant independently:

- exact project and sequence identity;
- stable media, occurrence, or transition identity;
- exact frame-aligned target range;
- preview token and pre-edit revision;
- executed placement or edit result;
- post-edit revision and observable timeline state;
- duration or range readback when requested;
- operation ID and Undo availability;
- Undo execution and restoration of the original state.

Do not treat discovery, string matches, headless tests, or a `ready` connection as placement or Undo proof. On screen lock, focus, permission, selection, stale preview, or capability errors, stop and report the exact blocker rather than inventing timeline state.
