# TDD plan: approved rough-cut native creation and readback (#544)

**Type:** QA
**Issue:** https://github.com/morshoto/framekit/issues/544
**Entry point:** the production MCP publish preview must reject an approved execution if its FCPXML digest changes. The existing test seam is `tests/integration/headless-project-mcp.test.ts`; keep the regression red before any contract repair.

## Goal and boundary

Prove that one exact, approved rough-cut FCPXML becomes a new editable Final Cut project with matching native project, sequence, and timeline readback. The issue requires a real headed import. Deterministic tests and FCPXML inspection support the run but cannot close it.

## Behaviors and tests

| ID | Observable behavior | First seam |
| --- | --- | --- |
| B1 | Production MCP preview binds the persisted approved execution, canonical revision, plan digest, FCPXML digest, source hashes, and absent new library target | `tests/integration/headless-project-mcp.test.ts` |
| B2 | Rejection, stale revision, changed artifact or source, missing target binding, and build or capability mismatch fail before import | `tests/integration/publisher.test.ts`, `tests/integration/runtime-alignment.test.ts` |
| B3 | A pending verification retries the same job without a second import or invented created target | `tests/integration/publisher.test.ts` |
| B4 | One separately authorized headed import creates the requested library, project, and sequence; native readback matches B/A/C trims, title, independent music, gain, audio policy, and sources | headed publish run and read-only Final Cut catalog/timeline inspection |
| B5 | The unrelated project, active-project transition, and source hashes are recorded before and after; failure and pending states remain explicit | headed readback plus before/after hashes and identities |

## Red, green, refactor cycles

1. **Preview provenance.** Red: add a focused public MCP regression for any uncovered B1/B2 mismatch and confirm the expected rejection is absent. Green: make only the publisher or MCP change needed to reject it. Refactor after green; run `pnpm exec tsx --test tests/integration/headless-project-mcp.test.ts tests/integration/publisher.test.ts tests/integration/runtime-alignment.test.ts`. Existing coverage must be inspected before adding duplicate tests.
2. **Pending retry.** Red: reproduce any observed duplicate import or false created-target status in `publisher.test.ts`. Green: preserve the job and retry verification only. Refactor after green; run the focused publisher suite.
3. **Native acceptance.** Red: record an actual failed precondition or mismatched readback against the exact approved artifact and disposable target. Green: fix a demonstrated product defect with a focused regression first, then obtain a fresh preview and separate approval for the changed candidate. Refactor only while focused tests pass. Repeat the headed check and preserve the original failure evidence.

## Preflight and execution order

1. Pin candidate source commit, packed MCP identity, installed extension fingerprint, Final Cut version, execution ID, revision, plan digest, artifact path and SHA-256, four source SHA-256 values, and a new absent `.fcpbundle` destination. Confirm the active unrelated project before any import.
2. Confirm the console is unlocked, Final Cut is frontmost with a visible timeline, the provider has native target binding, and runtime/extension builds match. Run `artifact.publish.preview` only after separate authorization for that exact non-mutating preview.
3. Present the immutable preview and obtain separate authorization for `artifact.publish.execute`. Import once. Inspect `artifact.publish.status` and native catalog/timeline readback for the same job. A pending state may resume verification only.
4. Recheck source hashes and unrelated project identity/state; attach sanitized evidence to #517 and coordinate the exact-package Codex run with #541.

The historical e38 approved render is evidence for its own commit and digest only. Reusing its files with a later candidate requires a fresh preview and approval. Never infer created-target proof from FCPXML UIDs or a document-open result.

## Completion

- All B1-B3 focused regressions and required repository gates pass on the exact candidate.
- B4-B5 have live, matching native evidence, or the PR reports the exact blocked/failed state without claiming acceptance.
- The result is linked into #517; #544 closes only after the real native exit criteria pass.
