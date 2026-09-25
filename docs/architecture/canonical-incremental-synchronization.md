# Canonical incremental synchronization

Status: contract version 1, defined for v0.1.13.

This document defines the shared read contract for `timeline.changes` and
`context.changes`. It makes a change result target-bound, revision-aware, and
explicit about what the provider actually observed. It does not add semantic
edit classes, content-based selection, or a new Final Cut provider.

## Result envelope

Both MCP surfaces use the same result envelope. `timeline.changes` populates
canonical timeline changes. `context.changes` may additionally carry editor
state and asset changes, but it keeps the same target, cursor, provenance, and
failure rules.

A complete result has this shape:

```json
{
  "contractVersion": 1,
  "ok": true,
  "status": "complete",
  "target": { "projectId": "project-1", "sequenceId": "sequence-1" },
  "from": {
    "target": { "projectId": "project-1", "sequenceId": "sequence-1" },
    "revision": { "id": "rev-10", "sequence": 10, "timestamp": "..." }
  },
  "to": {
    "target": { "projectId": "project-1", "sequenceId": "sequence-1" },
    "revision": { "id": "rev-12", "sequence": 12, "timestamp": "..." }
  },
  "changes": [],
  "provenance": {
    "source": {
      "provider": "final-cut-canonical",
      "backend": "headed-export-xml",
      "surface": "live",
      "evidenceTier": "canonical-live"
    },
    "observedAt": "..."
  }
}
```

The runtime types and structural validator live in
`packages/runtime/src/domain/incremental-sync.ts`.

## Revision cursor

The revision cursor is the pair of a stable target and the last observed
`ContextRevision`. A request asks for changes after `from` and returns a `to`
cursor for the newest observation. The cursor rules are:

- `from` and `to` identify the same project and sequence.
- Revision IDs are opaque; `sequence` is a non-negative, monotonic ordering
  value and `timestamp` is descriptive evidence.
- `to.sequence` cannot precede `from.sequence`.
- A change revision is within the returned cursor range.
- A provider that cannot reconcile the cursor must return `stale`, not guess,
  resend an unrelated timeline, or mutate the editor.

An empty change list is valid when the source is current. The returned `to`
cursor still records which observation was made.

## Stable target identity

`projectId` and `sequenceId` are stable provider identities: together they are
the stable project and sequence identities for the result. Names are
descriptive labels and never establish target identity. Every complete result
is bound to one exact project/sequence pair in the result target and both
cursors.

If a catalog/live reconciliation is name-only, ambiguous, unresolved, stale,
or points at a different project or sequence, the result is not complete. The
provider returns a structured `ambiguous` or `stale` failure with a diagnostic
and leaves the target unmodified.

## Ordered change semantics

Each change has a contiguous zero-based `order`, a revision, an entity, an
operation, and a stable entity ID. The result guarantees deterministic order
across repeated reads of the same revision range. The canonical total-order key
is:

1. `revision.sequence` ascending;
2. entity kind in this order: `clip`, `connected-item`, `marker`, `caption`,
   `role`, `audio`, `playhead`;
3. `entityId` ascending using lexical ordering;
4. operation in this order: `added`, `modified`, `removed`.

The operation determines provenance cardinality:
Before and after values are part of the change contract, not optional display
decoration.

| Operation | Required values | Meaning |
| --- | --- | --- |
| `added` | `after` only | The entity did not exist at `from` and exists at `to`. |
| `removed` | `before` only | The entity existed at `from` and no longer exists at `to`. |
| `modified` | `before` and `after` | The same stable entity changed between observations. |

The payloads remain provider-neutral. Follow-up field work must retain stable
identities, exact rational times, role/audio properties, and before/after
values rather than deriving changes from track position or floating-point
seconds.

## Provider/source provenance and evidence tiers

Every complete or failed result may report provider and backend provenance:

| Evidence tier | Meaning | Can claim canonical changes? |
| --- | --- | --- |
| `metadata-only` | Partial live state such as project name, playhead, or timing. | No; return `unavailable` with `METADATA_ONLY`. |
| `artifact-only` | A supplied or generated file, such as FCPXML, without live binding. | No live claim; retain the explicit tier. |
| `canonical-read` | A complete canonical snapshot read from a source. | Yes for a read result, with source scope preserved. |
| `canonical-live` | A complete snapshot bound to the selected live target. | Yes. |
| `headed-native` | Canonical evidence verified through the headed native path. | Yes, and retain the headed evidence distinction. |
| `fixture` | Deterministic test data. | Test evidence only; never release or native proof. |

Evidence tier is not inferred from a successful transport response. In
particular, a ready socket, preview, FCPXML artifact, fixture, or metadata-only
observation must not be promoted to canonical-live or headed-native evidence.

## Fail-closed results

Failures are structured rather than represented as an empty change list:

- `unavailable` reports `CAPABILITY_UNAVAILABLE` or `METADATA_ONLY` when the
  provider cannot produce a canonical observation.
- `stale` reports `STALE_CURSOR` and includes the requested revision cursor so
  the caller can perform a fresh observation.
- `ambiguous` reports `AMBIGUOUS_TARGET` when stable target identity cannot be
  resolved uniquely.

The failure message is actionable, and an optional target/cursor/provenance
must describe only what was actually observed. No failure path may silently
fall back to a guessed target, an empty canonical timeline, or a mutation.

## Follow-up boundaries

Issue #389 may expose the ordered provider/runtime/MCP path using this envelope.
Issue #390 may specialize the provider-neutral payloads with complete
before/after provenance for clips, connected items, markers, captions, roles,
audio, and playhead state. Those changes must preserve this contract and its
metadata-only and target-identity boundaries.
