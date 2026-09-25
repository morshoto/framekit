---
name: 🧪 QA / Validation
about: Track release, milestone, workflow, or editor validation for Framekit
title: "[QA] "
labels: "Type: Chore"
assignees: ""
---

## Validation target

<!-- Identify exactly what is being validated. -->

- Framekit version/commit:
- Target release/milestone/PR:
- Editor/provider:
- Operating system:
- Runtime mode: `headless` / `headed`

## Goal

<!-- What should this QA pass prove before the target can be considered validated? -->

## Preconditions

<!-- List required setup, fixtures, media, configuration, permissions, or application state. -->

- [ ]
- [ ]
- [ ]

## Test plan

### Deterministic / automated

<!-- Unit, integration, contract, build, lint, or fixture-based checks. -->

- [ ]
- [ ]
- [ ]

### Live editor / provider

<!-- Checks that require Final Cut Pro or another real editor/provider. Remove this section when not applicable. -->

- [ ]
- [ ]
- [ ]

### End-to-end workflow

<!-- Validate the user-visible flow from request/inspection through edit and final output when applicable. -->

- [ ]
- [ ]
- [ ]

## Safety checks

<!-- Verify fail-closed behavior and protection of user timeline/media state. -->

- [ ] Destructive operations require the expected preview/confirmation path.
- [ ] Invalid or unsupported operations fail closed without mutating project state.
- [ ] Failed/rejected operations leave timeline and media state unchanged.
- [ ] Undo/recovery behavior is validated when applicable.

## Results

- Passed:
- Failed:
- Blocked:
- Not tested:

## Failures and follow-ups

<!-- Link a Bug/Chore/Improvement issue for every unresolved failure or blocker. -->

| Finding | Status | Follow-up issue |
| --- | --- | --- |
|  |  |  |

## Evidence

<!-- Add relevant commands, MCP responses, test output, screenshots, exported files, or logs. Remove secrets and private media paths. -->

## Exit criteria

- [ ] All required QA checks have been executed.
- [ ] No unresolved blocking failures remain.
- [ ] Every unresolved non-blocking failure has a linked follow-up issue.
- [ ] Required live-editor and end-to-end evidence is attached or linked.
- [ ] The validation target can be considered complete for this QA scope.

## Additional context

<!-- Add related issues, PRs, release notes, known limitations, or anything else needed to interpret the results. -->
