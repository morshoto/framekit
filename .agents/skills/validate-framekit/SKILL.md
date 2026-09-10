---
name: validate-framekit
description: Run and report Framekit repository validation with deterministic install, build, test, boundary, and optional native Xcode gates. Use before a PR, after implementation or conflict repair, or whenever the user asks to validate, run tests, confirm a branch works, or provide concrete completion evidence.
---

# Validate Framekit

Run the repository gates from a real worktree, never from the bare repository root.

```sh
.agents/skills/validate-framekit/scripts/validate.sh
```

Use `--native` when Swift, Xcode project, native adapter, or headed Final Cut integration files changed. Use `--skip-install` only when the lockfile installation is already proven for the current worktree and toolchain.

## Evidence contract

Report:

- worktree path and head SHA;
- exact gates that passed, failed, or were skipped;
- the first actionable failure and command;
- whether native checks were required and run;
- evidence limitations.

Do not equate deterministic tests with headed Final Cut behavior, npm publication, or remote CI. Use `$verify-final-cut-native`, `$verify-release`, or `$triage-ci` for those separate proof surfaces.
