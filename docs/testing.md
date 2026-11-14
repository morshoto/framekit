# Testing

Run repository checks from the root with the locked dependencies:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run test
pnpm run check:boundaries
pnpm run check:docs
```

`pnpm run test` includes deterministic unit and integration tests, release
contract tests, and the documentation allowlist/link tests. PR CI runs the full
suite under the existing `Unit / integration tests` check; lint and tests run
in parallel. `test:fast` remains available for local feedback. Benchmarks, clean
Codex plugin installation, deterministic MCP evaluation, and release exercises remain in
Security CI after a push to `main` or on scheduled/manual runs.

`CI passed` checks every expected job result, including package consumer smoke
and Nix bootstrap. Docs type-checking and unit tests run once when relevant;
static exports run separately for root and `/framekit`. Only an explicit
successful negative Docs scope decision permits those jobs to skip. Detection
failure runs Docs validation and fails the aggregate. Failed, cancelled,
missing, and unexpectedly skipped jobs cannot pass the aggregate.

All PR jobs have explicit timeouts. Deterministic tests upload JUnit results,
JSON totals, and selected-file/toolchain/commit metadata; an interrupted phase
is reported as incomplete. Reports distinguish the tested merge commit from
the PR head. Workflow summaries and failure artifacts describe fixture or shim
evidence without claiming headed Final Cut proof.

Run `pnpm run check:workflows` to validate workflow syntax and expressions with
checksum-verified actionlint. Manual CI dispatch validates Docs unconditionally
and uses a separate concurrency group from PR runs.

### Required-check rollout

The workflow introduces `CI passed` without removing the existing required
check names. A workflow change alone does not update the live GitHub ruleset.
After the new workflow has merged, an authorized maintainer must add `CI passed`
from GitHub Actions to the main ruleset, retaining strict commit freshness and
all existing requirements: `Lint / static checks`, `Unit / integration tests`,
`Swift type-check`, and the separate `CodeQL PR policy`. Verify actual check
names and terminal results on the exact candidate commit before rollout; do not
require a check before `main` can emit it.

Audit the live configuration without changing it:

```sh
node scripts/ci/check-required-checks.mjs morshoto/framekit 20905528
```

The audit exits nonzero until all required contexts and their GitHub Actions
producer are enforced. Keep existing coverage until its required replacement
has passed hosted CI. The full deterministic replacement was verified before
removing Nix's duplicate fixture suite; Nix retains install, build, doctor, and
MCP smoke.

Hosted Swift validation explicitly selects the `ci` profile in
`nix/xcode-version.json`: Xcode 26.6 (17F113), macOS SDK 26.5. The default native
compatibility check retains Xcode 16.4 / SDK 15.5. Hosted validation lists the
project and type-checks the Swift source against a shim; it does not build the
extension or validate headed Final Cut behavior.

For native source changes, also run:

```sh
pnpm run xcode:check
xcodebuild -project adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/FramekitFinalCutWorkflow.xcodeproj -list
```

Headed Final Cut checks are opt-in and require a disposable project and the
specific consent and target required by that runner. Standard validation does
not launch or activate Final Cut Pro. Keep private media, raw tool output,
credentials, local filesystem paths, and crash dumps out of committed test
fixtures and reports.

For publisher QA, `pnpm run test:final-cut-publisher-headed --help` lists the
approved artifact digest, verified rough-cut execution, clean candidate commit,
new library destination, and explicit mutation consent required by the runner.
First use `.agents/skills/verify-final-cut-native/scripts/run-headed-check.sh
publisher` for a non-mutating console and foreground preflight. The runner
dispatches once and requests semantic readback separately; if dispatch is
uncertain, inspect the recorded job rather than dispatching again. Its output
keeps the issue verdict at NO-GO until the remaining identity and integrity
evidence has been independently reviewed.

## Project status automation

The `Assign` workflow keeps issue `Status:` labels and Project #3's Status
field aligned. Opening or reopening an issue selects Backlog; closing selects
Done. Adding a status label selects that status and removes the previous status
label. Removing the last status label resets it to Backlog. Manual dispatch
backfills existing issue cards, using a single status label first or seeding a
missing label from the board. Multiple labels are reported as conflicts.

The `PR project status` workflow updates existing open issue cards referenced
in a PR body (`Refs #123`, closing keywords, same-repository qualified references
or issue URLs), as well as GitHub's linked closing issues:

| Current related PR state | Issue label and project status |
| --- | --- |
| Open PR, including a draft | In progress |
| Submitted review or inline review comments | In review |
| Failed required CI, merge conflict, or branch behind the base | Pending |

Pending takes precedence over In review, which takes precedence over In progress
when several open PRs reference an issue. Running CI and missing approvals do
not select Pending. Optional failed checks do not select Pending. Clearing a
blocker restores the status from current PR state. Closed issues remain Done;
PR cards and other repositories are excluded. With no open related PR, the
existing issue status remains unchanged; merging a PR does not close an issue
unless GitHub's normal closing-link behavior does so.

PR, review, CI-completion, commit-status, and `main` push events trigger a
refresh. A roughly 15-minute scheduled refresh also handles delayed mergeability
updates, checks from other providers, and fork reviews whose event cannot access
the secret. Manual dispatch runs the same refresh. Each run reads current PR
and check state instead of replaying the triggering event. The workflow checks
out only the default branch and runs without installing PR dependencies.

Both workflows require the `GH_TOKEN_FRAMEKIT_PRJ` repository secret with access
to read PRs, checks, and projects and to update issue labels and Project #3.
A missing secret produces a warning and skips synchronization. Moving a card
on the board does not itself update its label. Automatic PR reconciliation can
replace a manually chosen status while a related PR remains open.

## Evidence levels

| Level | Reproducible proof | Limit |
| --- | --- | --- |
| Deterministic | In-memory fixture behavior, including preview, execution, readback, and Undo. | Does not prove editor or release state. |
| FCPXML artifact | Explicit document parsing, edit, write, or restoration. | Does not prove import into an open Final Cut project. |
| Metadata-only | Observed bridge identity, metadata, playhead, range, or events. | Does not prove a complete canonical timeline. |
| Canonical live | Provider-advertised timeline reads or writes with target and revision binding. | Unsupported capabilities remain unavailable. |
| Headed-native | Separately authorized disposable-project operation, exact-target readback, and Undo or rollback. | Applies only to the tested target, build, and operation. |

Report each level as verified, failed, unsupported, or unrun. Fixture evidence
does not become native proof; an unsupported or unrun level is not a pass.
Live Final Cut metadata and canonical timeline evidence remain separate;
require an explicitly advertised capability for each operation.
Preserve provenance by attaching sanitized reports to the relevant issue,
pull request, workflow run, or release. Detailed QA transcripts, one-time
plans, and ephemeral run logs do not belong in the maintained `docs/` tree.

## Focused validation commands

```sh
pnpm run evaluate
pnpm run test:golden
pnpm run test:clean-mcp-clients
pnpm run test:release-gate
pnpm run release-gate --output-dir artifacts/release-gate/local-run
pnpm run benchmark:filler-removal --output-dir artifacts/filler-removal/local-run
```

The clean client smoke test uses temporary Codex and Claude Code configuration
homes. It records package and plugin identities, sanitized tool results, and a
machine-readable `releaseCandidate` status; missing published artifacts remain
`NO_GO`. Use `FRAMEKIT_CLEAN_CLIENT=codex` or `claude` to select one client.
This does not require a repository checkout in the client configuration.

The release gate reports `report.json` and `manifest.json`. Keep deterministic,
FCPXML artifact, metadata-only, canonical-live, and headed-native tiers
separate; each can be `verified`, `failed`, `unsupported`, or `unrun`. Its
versioned native-editing acceptance manifest is v0.1.6. Its filler-removal
corpus covers obvious, protected-segment, multi-filler, quiet, silent,
peak-risk, and gain-clamp cases. The benchmark emits `results.jsonl` and
`manifest.json`; its current verified-success threshold is 95.0%. These
results do not establish native Final Cut behavior.

The headed-native tier is opt-in and requires a disposable project plus the
runner-specific target and mutation-consent configuration. The standard gate
does not run headed UI mutations by default. Use fresh output directories and run each authorized native command separately.
The dialogue command currently emits a non-passing single-case diagnostic;
it cannot complete the release-gate bundle:

```sh
mkdir -p artifacts/final-cut-headed
pnpm run test:final-cut-canonical-headed > artifacts/final-cut-headed/canonical-live.json
pnpm run test:final-cut-pip-headed > artifacts/final-cut-headed/picture-in-picture.json
pnpm run test:final-cut-title-headed > artifacts/final-cut-headed/built-in-title-discovery.json
pnpm run test:final-cut-masking-headed > artifacts/final-cut-headed/masking.json
pnpm run test:final-cut-filler-headed > artifacts/final-cut-headed/filler-removal.json
mkdir -p artifacts/final-cut-diagnostics
pnpm run test:final-cut-dialogue-headed > artifacts/final-cut-diagnostics/dialogue-normalization.json
pnpm run release-gate --output-dir artifacts/release-gate/headed-run --headed-evidence-dir artifacts/final-cut-headed --headed-candidate-commit "$FRAMEKIT_FINAL_CUT_E2E_CANDIDATE_COMMIT"
```

The dialogue diagnostic requires `FRAMEKIT_FINAL_CUT_E2E_ALLOW_MUTATION=1`
and an approved disposable target. Set `FRAMEKIT_FINAL_CUT_E2E_PROJECT`,
`FRAMEKIT_FINAL_CUT_E2E_PROJECT_ID`, `FRAMEKIT_FINAL_CUT_E2E_SEQUENCE_ID`,
`FRAMEKIT_FINAL_CUT_E2E_REVISION_ID`, `FRAMEKIT_FINAL_CUT_E2E_OCCURRENCE`,
`FRAMEKIT_FINAL_CUT_E2E_CANDIDATE_COMMIT`, `FRAMEKIT_FINAL_CUT_E2E_BASELINE_DIGEST`
(the canonical SHA-256), `FRAMEKIT_FINAL_CUT_E2E_SOURCE_DIGEST` (`sha256:…`), and
`FRAMEKIT_FINAL_CUT_E2E_APPROVED_GAIN_DB` (the approved absolute occurrence gain,
including its initial gain). Policy defaults are -16 LUFS, 0.5 LU tolerance,
-1 dBTP maximum, ±6 dB gain change, and one second minimum dialogue. Override
these with `FRAMEKIT_DIALOGUE_TARGET_LUFS`, `FRAMEKIT_DIALOGUE_TOLERANCE_DB`,
`FRAMEKIT_DIALOGUE_MAX_TRUE_PEAK_DB`, `FRAMEKIT_DIALOGUE_MIN_GAIN_DB`,
`FRAMEKIT_DIALOGUE_MAX_GAIN_DB`, and `FRAMEKIT_DIALOGUE_MIN_DURATION_SECONDS`.
Preflight with `.agents/skills/verify-final-cut-native/scripts/run-headed-check.sh dialogue-normalization`
before executing. Both the helper and direct runner check mutation consent;
the direct runner also requires a clean candidate and aligned loaded components.

Dialogue schema-v2 acceptance requires all twenty scenarios named by
`scripts/final-cut-dialogue-acceptance.mjs`, including measured quiet/loud and
nonzero-gain cases, repeated sources, NO_OP/SKIP and rejection cases, bounded
recovery, and writes blocked after recovery failure followed by observed
restoration. Each receipt binds the approved policy/token, target/revision,
source and unrelated-state integrity, independent signal references and
loaded package/plugin/extension/exporter/meter identities. Success cases need
actual isolated exported output with fresh request IDs, matching providers,
complete sample coverage, measured LUFS/true peak, and canonical gain/Undo
readback. Source-only measurements and boolean-only historical receipts fail.
The complete native suite collector, independent reference acquisition and
production occurrence exporter remain prerequisites; the current diagnostic
reports `passed: false` and `NO_GO`. Synthetic validator fixtures must never be
published as native receipts. Schema validation cannot authenticate acquisition.

The headed candidate must be a full lowercase commit SHA; every headed record
must match it. Missing, mismatched, or incomplete headed evidence makes the
command fail. This compares declared identities and does not authenticate files.

Only an explicit successful summary containing `headed-native=verified` and
`headed_native_status=verified` establishes the headed-native tier. The
sanitized evidence binds the exact project, sequence, occurrence, build,
before/after/restored revisions, and verification/Undo result. Keep private
media, raw responses, and machine paths out of committed artifacts.
For canonical mutation, set `FRAMEKIT_FINAL_CUT_E2E_PROJECT`,
`FRAMEKIT_FINAL_CUT_E2E_PROJECT_ID`, `FRAMEKIT_FINAL_CUT_E2E_SEQUENCE_ID`,
`FRAMEKIT_FINAL_CUT_E2E_REVISION_ID`, `FRAMEKIT_FINAL_CUT_E2E_CLIP_ID`,
`FRAMEKIT_FINAL_CUT_E2E_CANDIDATE_COMMIT`, and
`FRAMEKIT_FINAL_CUT_E2E_ALLOW_MUTATION=1` for the separately authorized run.
The runner requires a clean checkout at the approved commit, a matching loaded
extension, the approved active target and revision, and an unlocked, frontmost
Final Cut session. The runner uses `FRAMEKIT_FINAL_CUT_EXISTING_SOCKET_ONLY=1`
to stop if the existing Workflow Extension socket is unavailable; it does not
install, activate, or retry the connection. A target-bound read establishes the approved revision before
selection; a second read rejects changes during selection. It checks the exact rename preview and an unchanged target
readback before executing the one-use preview token; it does not retry a failed
Undo.
Canonical mutation evidence independently checks the snapshot digests, target
and source binding, advertised rename capability, and rename-only semantic
projection. The runner hashes every local source before editing and after Undo;
unreadable sources, final-component symlinks, or changed hashes block evidence.
The comparison is point-in-time evidence and cannot exclude an intervening
change that was subsequently reversed. The sanitized report includes hashes but
not source paths. The release-gate reader checks the canonical rename summary's
required workflow results, capabilities, source hashes, target diff, revisions,
and restoration digest. Structural checks do not authenticate supplied files;
review their provenance and candidate binding separately. The v0.1.6 canonical
workflow covers rename and is not the complete #614 operation matrix.
Dialogue normalization requires the runner's complete declared Skill
capability set before it can record headed-native evidence.

The separate Basic Final Cut Editing MVP fixture gate is not native proof.
For optional incremental-sync headed validation, use
`pnpm run test:final-cut-incremental-sync-headed` with a disposable
`FRAMEKIT_FINAL_CUT_E2E_PROJECT`, `FRAMEKIT_FINAL_CUT_E2E_PROJECT_ID`,
`FRAMEKIT_FINAL_CUT_E2E_SEQUENCE_ID`, and explicit
`FRAMEKIT_FINAL_CUT_E2E_ALLOW_EXTERNAL_EDIT` consent. A missing capability
remains unavailable rather than being filled with fixture data. The versioned
golden workflow corpus protects against zero silent corruption. CI runs the
required regression gate for background provider and routing; its separate
`pnpm run test:final-cut-background-headed` runner is opt-in.

The optional `pnpm run test:final-cut-rough-cut-headed` reports
`headed-native-rough-cut-acceptance`, accepts only a
disposable target, and records `sourceIdentity` with verified, failed,
unavailable, or unrun statuses. It does not promote unavailable native
capabilities into a successful result.

### CodeQL baselines for stacked pull requests

The JavaScript CodeQL policy requires an analysis of the exact base branch commit. Security scans pushes to branches for this baseline; full validation and Swift scanning remain limited to main on push. Existing branches must first contain this workflow change and receive a push, or run the Security workflow manually on that branch. If the child PR scan finishes before its base scan, rerun the child's CodeQL workflow after the base scan completes. Missing or stale baseline evidence fails the policy closed. The trusted policy is loaded from the default branch, so changes to it take effect only after merging.
