# TDD Plan: Validate v0.1.13 incremental synchronization and Final Cut readback (#432)

**Type**: QA tooling / validation
**Issue**: https://github.com/morshoto/framekit/issues/432
**Complexity**: High
**TDD Entry Point**: A sanitizer contract test that rejects incomplete or
metadata-only incremental-sync evidence and preserves only safe headed-native
summaries.

## Issue Summary

Issue #432 is the v0.1.13 milestone exit pass. The repository already has
deterministic coverage for revision cursors, ordered canonical changes, compact
context, target reconciliation, canonical recovery, and stale-session gating,
but it lacks one repeatable headed scenario that joins those behaviours around a
real Final Cut project and records sanitized evidence.

## Issue Excerpt

> Prove the v0.1.13 milestone exit criteria on a real disposable Final Cut
> project before merging the release PR.

## Scope

### In scope

- Add a headed Final Cut runner for stable project/sequence selection and
  canonical R0 readback.
- Pause for one controlled human edit, then verify R1, ordered
  `timeline.changes`, compact `context.changes`, and exact provenance.
- Create an R0-bound provider-neutral editing session, prove stale work is
  blocked, reconcile to R1, and prove session work can resume.
- Sanitize evidence so it records revisions, target identity, statuses,
  provenance, changed scopes, and session states without raw snapshots, media
  paths, operation IDs, or private diagnostics.
- Add deterministic tests for the evidence contract, runner wiring, and docs or
  package command discoverability.

### Out of scope

- New runtime or MCP semantics already covered by the v0.1.13 implementation.
- Framekit-native timeline mutation or Undo during this QA pass.
- Committing live Final Cut output, private media, raw snapshots, credentials,
  or user-specific state paths.

## Behaviour Inventory

| ID | Behaviour | Test level | First test file | Notes |
| --- | --- | --- | --- | --- |
| B1 | Evidence requires canonical headed capability, stable target identity, and advancing R0/R1 revisions. | Unit | `tests/integration/incremental-sync-evidence.test.ts` | Metadata-only and non-advancing runs fail closed. |
| B2 | Ordered timeline changes retain target, canonical-read provenance, and before/after evidence. | Unit | `tests/integration/incremental-sync-evidence.test.ts` | Added/removed/modified provenance is checked. |
| B3 | Context changes retain compact changed scopes and source provenance. | Unit | `tests/integration/incremental-sync-evidence.test.ts` | No raw canonical state is promoted into evidence. |
| B4 | An R0 session becomes `possibly_stale`, rejects preview, reconciles to R1, and resumes session-only work. | Headed integration | `scripts/final-cut-incremental-sync-headed-e2e.mjs` | The human edit is performed in disposable Final Cut. |
| B5 | The headed runner refuses unsafe setup and cleans temporary session state. | Integration | `tests/integration/incremental-sync-evidence.test.ts` | Requires project identity and explicit external-edit consent. |

## Acceptance Criteria as Tests

| Acceptance criterion | Test ID | Test name |
| --- | --- | --- |
| Canonical read is bound to the intended stable project and sequence. | B1/B4 | `sanitizes target-bound headed incremental evidence` |
| A real external edit advances R0 to R1 and yields ordered canonical changes. | B2/B4 | `retains ordered before-after timeline changes` |
| `context.changes` exposes compact source-bound incremental context. | B3/B4 | `retains compact context provenance and scopes` |
| Stale session work is blocked until reconciliation, then resumes. | B4 | `records stale blocking and successful reconciliation` |
| Metadata-only or incomplete evidence is never reported as canonical-live proof. | B1/B2/B3 | `rejects metadata-only and incomplete evidence` |

## Test-First Implementation Cycles

### Cycle 1: Evidence sanitizer contract

**Red**

- Add `tests/integration/incremental-sync-evidence.test.ts` importing the new
  `sanitizeIncrementalSyncEvidence` helper.
- Assert safe summary fields, target/revision binding, ordered change
  provenance, compact context scopes, stale blocking, reconciliation, and
  removal of raw/private fields.
- Add a metadata-only negative case and a missing-session-proof negative case.
- Run: `pnpm exec tsx --test tests/integration/incremental-sync-evidence.test.ts`

**Green**

- Add the smallest allowlisted sanitizer to `scripts/final-cut-evidence.mjs`.
- Validate the canonical capability mode, stable target, revision advance,
  change provenance, context envelope, and session state transition.
- Run the focused test until green.

**Refactor**

- Reuse existing revision, identity, environment, and capability sanitizers.
- Keep raw snapshots and paths out of the return value by construction.
- Run the evidence-focused integration tests.

### Cycle 2: Headed observe -> drift -> reconcile runner

**Red**

- Add runner source assertions for live Final Cut mode, disposable temp state,
  explicit external-edit consent, stable selection, `project.inspect`,
  `context.inspect`, `timeline.changes`, `context.changes`, session tools,
  and sanitizer usage.
- Expected failure: the runner does not exist.
- Run: `pnpm exec tsx --test tests/integration/incremental-sync-evidence.test.ts`

**Green**

- Add `scripts/final-cut-incremental-sync-headed-e2e.mjs`.
- Connect read-only to the live bridge, bind the configured stable target, and
  capture R0.
- Require the operator to make one controlled disposable-project edit, capture
  R1, query both change surfaces, and assert target/provenance.
- Create an R0 session from `createTimelineIrFromProjectSnapshot`, verify
  `RECONCILIATION_REQUIRED`, reconcile with R1, and perform a session-only
  operation after recovery.
- Sanitize and print evidence; remove temporary state in `finally`.

**Refactor**

- Keep the runner read-only from Framekit’s perspective; do not add a native
  mutation or rollback shortcut.
- Keep operator instructions explicit and make all failure codes actionable.
- Run the focused source-contract tests.

### Cycle 3: Discoverability and documentation

**Red**

- Assert a package script and validation documentation name the new runner and
  required environment variables.
- Expected failure: the command and runbook are absent.

**Green**

- Add `test:final-cut-incremental-sync-headed` to `package.json`.
- Document the command, preflight requirements, external-edit consent, and
  evidence limitations in `docs/validation/README.md`.
- Run the focused documentation and package-contract tests.

**Refactor**

- Check naming against the existing `FRAMEKIT_FINAL_CUT_E2E_*` variables.
- Ensure no generated evidence or private paths are tracked.

### Cycle 4: Repository and native validation

**Red/Green**

- Run deterministic install, build, tests, and boundary checks.
- Run native/Xcode checks because the new runner is headed Final Cut tooling.
- Run the headed preflight without execution; run the headed scenario only when
  the disposable project, unlocked console, connected extension, permissions,
  and explicit external-edit consent are available.

**Refactor**

- Review the complete diff and evidence-tier wording.
- Report deterministic, native-preflight, headed, and remote-CI states
  separately.

## Affected Files

| File | Action | TDD role | Description |
| --- | --- | --- | --- |
| `docs/project/432-tdd-plan.md` | Create | Plan | Implementation-ready issue plan. |
| `tests/integration/incremental-sync-evidence.test.ts` | Create | Red | Sanitizer and runner contract tests. |
| `scripts/final-cut-evidence.mjs` | Modify | Green | Allowlisted incremental-sync evidence sanitizer. |
| `scripts/final-cut-incremental-sync-headed-e2e.mjs` | Create | Green | Headed observe/drift/reconcile workflow. |
| `package.json` | Modify | Green | Discoverable headed runner command. |
| `docs/validation/README.md` | Modify | Refactor | v0.1.13 validation runbook and limitations. |

## Test Commands

### Focused cycle commands

```bash
pnpm exec tsx --test tests/integration/incremental-sync-evidence.test.ts
pnpm exec tsx --test tests/integration/canonical-incremental-contract.test.ts tests/integration/canonical-timeline-changes.test.ts tests/integration/drift-reconciliation.test.ts tests/integration/headless-session-mcp.test.ts
```

### Final verification

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run test
pnpm run check:boundaries
pnpm run xcode:check
xcodebuild -project adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/FramekitFinalCutWorkflow.xcodeproj -list
```

### Headed evidence

```bash
.agents/skills/verify-final-cut-native/scripts/run-headed-check.sh --help
.agents/skills/verify-final-cut-native/scripts/run-headed-check.sh canonical-read
FRAMEKIT_FINAL_CUT_E2E_PROJECT_ID=... FRAMEKIT_FINAL_CUT_E2E_SEQUENCE_ID=... \
  pnpm run test:final-cut-project-selection-headed
FRAMEKIT_FINAL_CUT_E2E_ALLOW_EXTERNAL_EDIT=1 pnpm run test:final-cut-incremental-sync-headed
```

The headed command is not a deterministic CI substitute. Its evidence remains
`headed-native` only when the real Final Cut scenario passes with the configured
disposable target and sanitized output.

## Risks and Mitigations

- **Risk**: A live bridge is `ready` but cannot provide canonical state.
  **Mitigation**: Require canonical capability flags and fail with the exact
  `CAPABILITY_UNAVAILABLE` reason.
- **Risk**: A human edits the wrong project or sequence.
  **Mitigation**: Bind stable IDs before and after the edit and reject target
  drift before recording evidence.
- **Risk**: Incremental output accidentally leaks raw/private state.
  **Mitigation**: Sanitize through an allowlist and test that raw snapshots,
  media sources, operation IDs, and private paths are absent.
- **Risk**: Stale session evidence is inferred without a blocked operation.
  **Mitigation**: Require both `RECONCILIATION_REQUIRED` and a post-reconcile
  session operation in the evidence contract.

## Definition of Done

- [ ] Every new evidence behaviour has a focused test.
- [ ] The headed runner proves stable target identity, R0/R1, changes, context,
  stale blocking, reconciliation, and resumed session work when prerequisites
  are available.
- [ ] Metadata-only, artifact-only, and deterministic evidence are not promoted
  to headed-native proof.
- [ ] Temporary session state is cleaned up and no private evidence is tracked.
- [ ] Required deterministic and native validation results are reported with
  unavailable/not-run states preserved.
