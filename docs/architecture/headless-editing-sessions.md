# Headless editing sessions

Framekit persists provider-neutral editing sessions beneath
`FRAMEKIT_STATE_DIR`. When the variable is unset, the MCP server uses
`~/.framekit`. Session documents and materialization job checkpoints are
written through same-directory temporary files and atomic renames. Staged
FCPXML artifacts use exclusive creation and are verified by digest before a
retry.

The agent workflow is:

```text
provider Timeline IR -> session base/desired -> preview/execute
                    -> observe/reconcile -> FCPXML job -> provider
```

## Observation boundary

`session.observe` calls the Final Cut SQLite inspection provider in read-only
mode. The persisted evidence contains a one-way source identifier, digest,
schema version, backend, and observation time. It does not persist or return the
database path. SQLite evidence always has `canonical: false` and incomplete
coverage. A changed digest marks the session `possibly_stale`; only a fresh
provider Timeline IR and `session.reconcile` can restore materialization
readiness. Framekit does not write Final Cut SQLite databases in this workflow.

## Materialization boundary

Preview compiles deterministic FCPXML in memory and performs no write. Execute
requires confirmation and an explicit library-facing project/sequence target,
then stages a new versioned destination. Existing projects are never selected
for reuse by this MCP surface.

Job evidence is deliberately layered in this order: artifact,
provider-requested, canonical-readback, headed-native. Artifact verification or
a provider request does not imply Final Cut completion. A job is completed only
after canonical readback matches the desired Timeline IR. Headed-native remains
false unless the configured provider separately supplies that proof.

Without a publication provider, execution checkpoints a retryable blocked job.
After a server restart, `session.materialize.status` reports the same job and
`session.materialize.retry` verifies the staged digest before requesting the
provider again.

Set `FRAMEKIT_FINAL_CUT_BACKGROUND_MATERIALIZATION_COMMAND` only to an explicit
non-UI Final Cut publisher. Framekit sends that command one JSON request on
standard input containing the immutable artifact path, digest, target, and
desired Timeline IR; it must return the materialization result as JSON on
standard output. The command must perform target-bound readback itself.
Framekit never substitutes the headed AppleScript publisher when this command
is absent or fails. The command is bounded by a 30-second deadline by default;
an unavailable, failed, or timed-out command remains a retryable structured
blocker rather than leaving the materialization request pending.
