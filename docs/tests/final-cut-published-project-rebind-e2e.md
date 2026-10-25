# Published Final Cut project rebind QA

## Purpose

Verify that a project created from an approved Framekit canonical revision can
be rebound after an MCP restart by stable native identity and resumed from a
complete canonical snapshot. Deterministic MCP tests establish contract
behavior; only the headed workflow below establishes live Final Cut evidence.

## Deterministic contract checks

Run the focused tests during development:

```sh
pnpm exec tsx --test \
  tests/integration/runtime-alignment.test.ts \
  tests/integration/final-cut-publish-readback.test.ts \
  tests/integration/canonical-resync-mcp.test.ts \
  tests/integration/headless-session-mcp.test.ts
```

These checks cover verified target persistence across a publisher restart,
exact project/sequence selection in a fresh MCP session, conflicting
library/event identity, semantic readback, partial observation escalation,
and stale-session blocking. They do not establish that Final Cut imported or
read back a real project.

## Pin and prepare the live candidate

Before starting, record the full Framekit commit, installed MCP package and
Codex plugin fingerprints, loaded Workflow Extension version and commit, macOS
build, and Final Cut version. Use the exact v0.1.18 candidate under review.

Prepare an isolated disposable library with three distinguishable video clips,
an editable title, and independent music. Record the approved canonical
revision, FCPXML digest, source-media hashes, created library/event/project/
sequence IDs, and an unrelated active project identity. Reuse the #517 B→A→C
reference edit where practical.

## Headed verification

Any import, foreground activation, XML export, manual timeline change, or other
headed interaction requires explicit user authorization for that action and
the disposable target. Headless approval does not grant that authorization.

1. Through production MCP, preview and execute the approved new-project
   publish. Record its job ID and verified library, event, project, and
   sequence IDs. Stop if readiness is blocked or the IDs are missing or
   contradictory.
2. Restart the MCP process with the same `FRAMEKIT_STATE_DIR` and exact
   candidate. Call `artifact.publish.status` and
   `editor.native.handoff.readiness` for the saved job ID. Confirm that all
   stable IDs match the publish result.
3. In the fresh session, call `project.select` with the verified project and
   sequence IDs. Read the target through the supported canonical provider and
   confirm the same library/project/sequence identity. Do not select by a
   display name alone.
4. Compare clip order B→A→C, source bindings, source ranges, rational timeline
   offsets and durations, title, music track, role, gain, provenance, and
   revision against the approved Timeline IR. Record each field as matched,
   degraded, unsupported, or unknown.
5. If the normal provider returns partial or metadata-only state, require an
   explicit `canonical-resync-required` result. Obtain separate authorization
   before exporting FCPXML, validate the complete snapshot, and compare it to
   the approved revision. Never promote catalog, SQLite/WAL, or display-name
   evidence to canonical truth.
6. After separate authorization, make one controlled manual change in the
   disposable project. Re-observe and verify that the old session is stale and
   preview, execution, and materialization stay blocked until validated
   reconciliation or canonical resync establishes a fresh baseline.
7. Confirm unrelated projects, source media, and editor selection/focus were
   not unexpectedly changed. Record unavoidable foreground or export effects.

Capture sanitized request/result summaries, exact build fingerprints, stable
target IDs, canonical coverage and semantic diff, stale-blocking/resync
results, and before/after unrelated-project and media checks. Do not attach
private media, credentials, raw snapshots, or user-specific local paths.

## Reporting

Report every required check as passed, failed, blocked, or not tested. A
missing release candidate, runtime/extension mismatch, incomplete canonical
snapshot, or unavailable headed capability blocks native acceptance. Link the
sanitized result to #551 and #517; do not infer v0.2.0 native edit/Undo or
overall v0.1.18 release acceptance from deterministic test results.
