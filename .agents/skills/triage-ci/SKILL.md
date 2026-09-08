---
name: triage-ci
description: Diagnose Framekit GitHub Actions failures or slow jobs from live PR and run evidence, reproduce the exact failing step locally, apply the smallest justified fix, and verify the post-push run. Use for requests to investigate CI, fix failing checks, explain a slow CodeQL job, or fix CI and merge.
---

# Triage Framekit CI

Collect live evidence first:

```sh
.agents/skills/triage-ci/scripts/collect-ci.sh OWNER/REPO --pr PR_NUMBER
.agents/skills/triage-ci/scripts/collect-ci.sh OWNER/REPO --run RUN_ID
```

## Diagnose and fix

1. Confirm the live head SHA, workflow, job, step, conclusion, actor, and event.
2. Read the failed or slow step logs. Distinguish queue time, setup, build extraction, tests, and query execution.
3. Reproduce the exact command with the repository toolchain before changing YAML or source.
4. Identify whether the failure is source, toolchain, permissions, external account state, or flaky infrastructure.
5. Apply the smallest bounded fix with a regression assertion where possible.
6. Invoke `$validate-framekit`, push when requested, and collect the replacement remote run.

Do not claim a CI improvement from local success alone. If the user says “fix the CI and merge,” wait for all required terminal checks before merging; repository policy and explicit user authorization still control the merge.
