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
contract tests, and the documentation allowlist/link tests. CI also runs a
clean Codex plugin install, deterministic MCP evaluation, the filler-removal
benchmark, and the repository release gate. A documentation-only change still
runs build, the full test suite, package-boundary checks, documentation checks,
and release validation.

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
pnpm run release-gate --output-dir artifacts/release-gate/headed-run --headed-evidence-dir artifacts/final-cut-headed
```

Only an explicit successful summary containing `headed-native=verified` and
`headed_native_status=verified` establishes the headed-native tier. The
sanitized evidence binds the exact project, sequence, occurrence, build,
before/after/restored revisions, and verification/Undo result. Keep private
media, raw responses, and machine paths out of committed artifacts.
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
