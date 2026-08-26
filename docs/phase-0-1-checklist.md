# Phase 0 and Phase 1 Checklist

Status: reviewed against `docs/PRD.md` v0.2 on 2026-08-26.

This checklist converts the PRD roadmap and Final Cut MVP requirements into
reviewable delivery gates. A checked item means that the current repository has
automated or documented evidence for the contract. It does not automatically
mean that the operation has been proven against a live, open Final Cut timeline.

## Source of truth

The checklist is derived from:

- [Agent Loop](./PRD.md#12-agent-loop)
- [Video TDD](./PRD.md#13-video-tdd)
- [Video Diff](./PRD.md#14-video-diff)
- [Editing Transactions](./PRD.md#15-editing-transactions)
- [Final Cut-Specific MVP](./PRD.md#22-final-cut-specific-mvp)
- [Technical Success Criteria](./PRD.md#23-technical-success-criteria)
- [MVP Success Metrics](./PRD.md#24-mvp-success-metrics)
- [Roadmap](./PRD.md#26-roadmap)

Phase 2 items—incremental synchronization, visual analysis, broader media
understanding, and native asset discovery—are intentionally not exit criteria
for this document.

## Phase 0 — Technical Spikes

PRD goal: prove the basic agent editing loop against deterministic data:

`read → write → read-after-write → diff → MCP connection`

### Runtime contract

- [x] Read a deterministic project and timeline snapshot.
- [x] Apply a supported write to the snapshot.
- [x] Re-read the editor after the write and return the newer revision.
- [x] Produce an inspectable diff containing the changed timeline item and
  affected range/metadata.
- [x] Reject a write based on a stale inspected revision.
- [x] Keep the runtime contract independent of MCP and Final Cut adapter
  modules.

### MCP surface

- [x] Expose project/timeline inspection through the MCP stdio server.
- [x] Expose a supported Phase 0 edit through MCP.
- [x] Expose the resulting diff through MCP.
- [x] Publish discoverable input schemas for timeline and native edit tools;
  the MCP client can learn required fields from `tools/list`.
- [x] Preserve explicit failure responses for unsupported or stale operations.

### Phase 0 evidence and exit gate

- [x] Deterministic integration tests cover read, write, read-after-write, and
  diff: [Phase 0 tests](./tests/phase-0.md).
- [x] MCP stdio wiring is covered by the integration suite.
- [x] The repository test suite passes for the Phase 0 contract.
- [x] Exit gate: one deterministic workflow completes
  `read → write → read-after-write → diff` through MCP.
- [x] Limitation is documented: Phase 0 does not prove that Final Cut Pro is
  open or that the native Workflow Extension enumerates a complete timeline.

## Phase 1 — Final Cut Runtime

PRD goal: implement the Final Cut adapter, timeline context, speech/audio
analysis, transactions, verification, and MCP exposure.

### Adapter and context

- [x] Provide an editor-independent adapter contract with a Final Cut
  implementation.
- [x] Read Final Cut project metadata, sequence/timeline metadata, clips,
  connected/story elements, media references, markers, and captions where the
  source provides them.
- [x] Preserve exact rational timeline times through the runtime and MCP
  boundary.
- [x] Attach context revisions to observations and reject stale writes and
  rollback attempts.
- [x] Report editor/backend capabilities and limitations explicitly.
- [x] Fail closed when stable Final Cut project or sequence identity is not
  available; mutable names are not identity fallbacks.

### Speech and audio analysis

- [x] Define speech-analysis and audio-analysis ports.
- [x] Support transcript/speech ranges, filler/silence-related analysis, and
  audio loudness/peak measurements through deterministic fixtures or configured
  local providers.
- [x] Invoke configured analysis for affected ranges during verification.
- [x] Return explicit unavailable/failed/invalid-provider errors rather than
  inventing analysis results.

### Editing transactions

- [x] Record intent, before state, proposed/applied operations, after state,
  diff, verification results, and transaction status.
- [x] Support the Phase 1 Final Cut MVP write contracts: trim, ripple delete,
  gain adjustment, and marker creation where the selected backend advertises
  the capability.
- [x] Keep writes revision-checked and verify the post-write observation.
- [x] Produce a deterministic diff for each completed transaction.
- [x] Support successful undo to the pre-edit snapshot.
- [x] Roll back after verification failure.
- [x] Compensate for a partial adapter write and report the transaction as
  failed when restoration cannot be confirmed.

### Verification

- [x] Verify structural validity: non-negative durations and resolvable media
  references.
- [x] Verify that the expected timeline change and newer revision occurred.
- [x] Verify transcript continuity for speech-affecting edits.
- [x] Verify audio loudness and peak policies when measurements are available.
- [x] Expose transaction diff, verification, and undo through MCP.

### Final Cut and MCP evidence

- [x] Expose the Phase 1 runtime through MCP tools for context, analysis,
  editing, diff, verification, and undo.
- [x] Verify the MCP tool list exposes the editing inputs instead of an empty
  schema; execution still applies strict per-operation validation.
- [x] Verify the FCPXML/document-backed Final Cut path for canonical reads,
  artifact edits, read-after-write, diff, verification, and rollback.
- [x] Verify the Workflow Extension can connect and report the active Final Cut
  project, sequence, playhead/range state, and revisions/events:
  [sanitized live evidence](./tests/evidence/2026-08-16-phase-1-live.md).
- [x] Keep the live-only backend honest in the compatibility matrix: it is
  metadata/event capable, not a complete canonical timeline backend.
- [x] Keep unsupported live operations fail-closed with explicit capability
  errors.

### Phase 1 release-gate follow-up

These are the remaining checks if “Final Cut Runtime” means mutation of the
currently open native timeline, rather than the implemented adapter contract
and FCPXML artifact path:

- [ ] Provide a supported native canonical timeline enumeration surface for
  the open Final Cut project.
- [ ] Execute a disposable live Final Cut edit and prove native read-after-write
  state, timeline diff, verification, and undo/rollback.
- [ ] Add sanitized headed evidence for that native mutation path; do not use
  fixture or FCPXML artifact results as proof that the open timeline changed.

Current boundary: the live Workflow Extension path intentionally remains
metadata/event-only for canonical timeline operations. The supported live
validation and fail-closed behavior are documented in the [Final Cut live E2E
guide](./tests/final-cut-live-e2e.md) and [compatibility matrix](./COMPATIBILITY.md).

## PRD success-metric follow-up

These items come from the PRD technical success criteria and MVP metrics. They
are tracked separately from the implementation contracts above because some
require a maintained benchmark corpus or independent client validation.

- [x] Deterministic supported-fixture parsing and exact frame/time round trips
  are covered by adapter tests.
- [x] Rollback and post-edit context-update contracts are covered by runtime
  and integration tests; this does not claim Phase 2's broader synchronization
  engine is complete.
- [ ] Establish a zero-silent-corruption result across a maintained golden
  workflow corpus; current tests cover guarded scenarios but do not establish
  that corpus-wide metric.
- [ ] Measure the PRD target of at least 95% successful verification on
  controlled filler-removal fixtures.
- [ ] Verify successful MCP invocation from both Codex and Claude Code in clean
  client sessions.
- [x] Preserve the PRD's local-first setup: the runtime and MCP server do not
  require a hosted service.
- [ ] Prove the complete PRD filler-removal loop against a live Final Cut
  timeline; this remains blocked by the native canonical timeline boundary
  above.

## Audit record — 2026-08-26

- [x] Default fixture MCP server initialized over stdio; `tools/list`, project
  and context inspection, speech/audio analysis, editing intent, timeline edit,
  diff, verification, and undo were exercised successfully.
- [x] Live headless MCP server connected to the installed Workflow Extension;
  `connection.status` reported `ready`, and `editor.live.inspect` returned the
  active project, sequence, rational playhead/range, and revision.
- [x] Live-only MCP correctly rejected canonical project inspection, canonical
  timeline editing, speech analysis, and native editing while reporting the
  corresponding capability limitations.
- [x] Live state and event responses reject unavailable rational times rather
  than exposing zero-timescale values to MCP clients; the live MCP probe
  returned `FINAL_CUT_LIVE_PROTOCOL` for the malformed bootstrap event.
- [ ] The bounded headed overlay check could not start because Accessibility
  could not find the `Framekit` window (`FINAL_CUT_E2E_OVERLAY_WINDOW_MISSING`);
  no native mutation was performed.
- [x] The live audit performed no native timeline mutation.

## Validation commands

Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run test
pnpm run check:boundaries
```

For the native Phase 1 path, also run:

```sh
pnpm run xcode:check
xcodebuild -project adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/FramekitFinalCutWorkflow.xcodeproj -list
```

Use [Phase 0 tests](./tests/phase-0.md), [Phase 1 tests](./tests/phase-1.md),
the [test matrix](./tests/test-matrix.md), and the [live E2E guide](./tests/final-cut-live-e2e.md)
to attach command output and environment-specific evidence to a release or PR.
