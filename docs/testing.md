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

PR summaries also expose per-package branch-coverage baselines, critical
persistence/recovery files, slow-test timings, and reviewed platform/opt-in
skip reasons. Coverage includes unvisited source files and has no global
threshold. Compact JSON/JUnit/coverage artifacts retain provenance and failing
seed diagnostics; raw V8 temporary data is not uploaded.

Use `pnpm test --file <reviewed-test-path> --test-name-pattern <regex>` or
`pnpm run test:watch --file <reviewed-test-path>` for isolated focused feedback.
See the [suite commands, responsibility layout, and discovery boundaries](../tests/README.md)
for metadata review and generated-test replay instructions.

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

### Manual FCPXML import and export QA

The following workflow prepares disposable, non-private media and an FCPXML
artifact through production MCP. It does not open Final Cut or operate on a
native project. Create the fixture in a **new** directory; the command refuses
to reuse an existing one:

```sh
node --import tsx scripts/manual-import-qa.ts prepare /path/to/new-qa-fixture
```

`reference.json` records the candidate commit, whether the checkout was dirty,
source and artifact SHA-256 hashes, and independently stated clip ranges,
title, music, and expected samples. Use a clean checkout and pin the exact
candidate. The three video inputs have a black lead-in; the JSON edit selects a
one-second colored range starting at one second from each. A successful artifact
check does not prove Final Cut behavior.

For the headed portion, obtain explicit approval for the exact disposable
library, generated FCPXML, operations, and new export path. In Final Cut,
create and select a new isolated library; use **File > Import > XML** and import
`edit.fcpxml`. Confirm the import targets the disposable library before
proceeding; stop if the destination is ambiguous or an existing project could
be overwritten. Confirm all three trimmed clips are present in red, green, blue
order, play the timeline, and inspect the basic title and static music. Verify
that the title text can be edited independently in the disposable project.
Record the actual Framekit, Final Cut, and macOS versions, library and project
identities, the import path, any warnings, and sanitized observations.

Select the disposable project and use **File > Share > Export File** to a new
movie path. After Final Cut finishes its export, run:

```sh
node --import tsx scripts/manual-import-qa.ts inspect /path/to/qa-fixture /path/to/final-cut-export.mov /path/to/new-observation-directory
```

The inspector rechecks artifact and source hashes, checks duration, frame rate and frame count, samples
clip interiors and adjacent boundary frames, measures the 880 Hz music tone,
and saves a frame for human title-visibility inspection. It never asserts that
a movie came from Final Cut, that import succeeded, or that the title is
editable. Record those observations separately and verify title text in the
saved frame. Missing media, import errors, missing/unsupported title assets,
failed measurements, or ambiguous provenance are FAIL or BLOCKED; never
convert an unobserved condition into PASS. Do not clear or replay a retained
native reservation. A synthetic or FFmpeg-rendered movie is not a substitute
for the actual Final Cut export.

Apple documents [XML import](https://support.apple.com/guide/final-cut-pro/verdbd66ae/mac)
and [Export File](https://support.apple.com/guide/final-cut-pro/export-final-mastering-files-ver0192a47b8/mac).

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
field aligned. Issue templates apply `Status: Backlog`. Opening or reopening an issue selects
Backlog; closing selects Done. To signal local work before opening a PR, add
`Status: In progress`. Adding a status label selects that status and removes the previous status
label. Removing the last status label resets it to Backlog. Manual dispatch
backfills existing issue cards, using a single status label first or seeding a
missing label from the board. Multiple labels are reported as conflicts.

The `PR project status` workflow updates existing open issue cards referenced
in a PR body (`Refs #123`, closing keywords, same-repository qualified references
or issue URLs), as well as GitHub's linked closing issues:

| Current related PR state | Issue label and project status |
| --- | --- |
| Open draft PR | In progress |
| Open PR ready for review | In review |
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
does not run headed UI mutations by default. For a complete release-gate
bundle, use a fresh output directory and run each native command separately:

```sh
mkdir -p artifacts/final-cut-headed
pnpm run test:final-cut-canonical-headed > artifacts/final-cut-headed/canonical-live.json
pnpm run test:final-cut-pip-headed > artifacts/final-cut-headed/picture-in-picture.json
pnpm run test:final-cut-title-headed > artifacts/final-cut-headed/built-in-title-discovery.json
pnpm run test:final-cut-masking-headed > artifacts/final-cut-headed/masking.json
pnpm run test:final-cut-filler-headed > artifacts/final-cut-headed/filler-removal.json
pnpm run test:final-cut-dialogue-headed > artifacts/final-cut-headed/dialogue-normalization.json
pnpm run release-gate --output-dir artifacts/release-gate/headed-run --headed-evidence-dir artifacts/final-cut-headed --headed-candidate-commit "$FRAMEKIT_FINAL_CUT_E2E_CANDIDATE_COMMIT"
```

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
