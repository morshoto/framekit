# Headless editing sessions

Framekit persists provider-neutral editing sessions beneath
`FRAMEKIT_STATE_DIR`. When the variable is unset, the MCP server uses
`~/.framekit`. Session documents and materialization job checkpoints are
written through same-directory temporary files and atomic renames. Staged
FCPXML artifacts use exclusive creation and are verified by digest before a
retry.

The agent workflow is:

```text
provider Timeline IR -> session base/desired -> provider change stream
                    -> fresh preview/execute -> observe/reconcile -> FCPXML job
                    -> provider
```

## Provider freshness boundary

The MCP server connects the provider's canonical `changesSince` stream to every
persisted session operation. Before session preview, execution, status, or
materialization, the stream is queried from the session BASE revision. A changed
provider revision marks the session `possibly_stale` and preserves BASE and
OURS/desired exactly; both editing and materialization remain blocked until a
fresh provider Timeline IR is explicitly reconciled as THEIRS. A change-stream
cursor mismatch is also fail-closed. This freshness check is distinct from the
non-canonical SQLite observation below and never promotes metadata evidence to a
canonical write authorization.

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
requires confirmation and an explicit `libraryUid`, `eventUid`, `projectUid`,
and `sequenceUid` target, then stages a new versioned destination. Existing
projects are never selected for reuse by this MCP surface.

Job evidence is deliberately layered in this order: artifact,
provider-requested, canonical-readback, headed-native. Artifact verification or
a provider request does not imply Final Cut completion. A job is completed only
after canonical readback matches the desired Timeline IR. Headed-native remains
false unless the configured provider separately supplies that proof.

Without a publication provider, execution checkpoints a retryable blocked job.
After a server restart, `session.materialize.status` reports the same job and
`session.materialize.retry` verifies the staged digest before requesting the
provider again. A retry first claims the job with an atomic claim file and
persists `publishing`; concurrent retries return that in-progress state and do
not call the provider a second time. The staged session digest is also checked
before publication. A changed session fails closed and must be reconciled.

## Background Final Cut publication

Production MCP wiring exposes a background publisher only when
`FRAMEKIT_FINAL_CUT_BACKGROUND_MATERIALIZATION_COMMAND` is configured while
`FRAMEKIT_EDITOR=final-cut-live`. The command is an explicit non-UI capability:
Framekit sends one JSON request on stdin and expects one JSON result on stdout.
The request contains the digest-verified artifact, the explicit target, the
versioned destination, `collisionPolicy: "create-only"`, and the desired
Timeline IR snapshot. The command must not activate or focus Final Cut, write
SQLite or `.fcpbundle` internals, or replace an existing project.

A completed command result must contain `canonicalReadback`, the exact created
`canonicalTarget` identity, and `headedNativeVerified: false`. Framekit checks
both the Timeline IR digest and the target identity before completing the job.
Locked-console or unavailable-capability responses remain structured retryable
blockers; a provider request alone is never success.
Configured publisher commands are bounded by a 30-second deadline by default;
unavailable, failed, or timed-out commands remain retryable structured blockers
rather than leaving materialization pending.

The disposable-library experiment matrix is separate from deterministic tests:

| State | Required evidence | Expected result |
| --- | --- | --- |
| Console unlocked, Final Cut backgrounded | Created versioned project and target-bound canonical readback | Background completion may be reported |
| Console unlocked, Final Cut frontmost | Same identity/readback evidence, without relying on UI focus | Background completion may be reported; headed proof remains false |
| macOS console locked | Sanitized lock source and no mutation evidence | Structured non-mutating blocker only |

Run each row against a disposable library and retain sanitized project/event/
sequence identities, provider status, canonical readback, and evidence tier.
The existing locked-console FCPXML experiment remains read-only and cannot be
used as proof of background materialization.
