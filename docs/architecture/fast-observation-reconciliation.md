# Fast observation reconciliation

Fast observations are provider-neutral evidence envelopes, not alternate
canonical reads. Every envelope carries the project/sequence target, the
Framekit materialization revision and artifact digest, source type, trust and
freshness, field-level coverage, an observation digest, and explicit unknowns.

The runtime accepts a normalized `TimelineIr` only when its digest and revision
agree with the envelope. A complete normalized editor read is reconciled through
the existing `EditingSession` three-way state machine:

```text
BASE (known Framekit revision) + OURS (desired session) + THEIRS (observation)
                                      |
                         EditingSession.reconcile()
                                      |
                rebased / conflicted / canonical resync required
```

Partial, storage-only, stale, or unknown evidence marks the session
`possibly_stale` and preserves the known baseline. Target or provider mismatch,
contradictory digests, and revision mismatches fail closed. SQLite/WAL evidence
from #493 remains structural and storage-observed; pasteboard normalization from
#416 preserves missing relationships, markers, captions, and side-effect
unknowns. Neither path advertises `canonicalDocument.read`.

Only a complete normalized observation may advance the session as an unchanged
baseline, an expected Framekit advancement, or a proven structural delta. An
ambiguous or contradictory result must obtain a validated canonical FCPXML
resync through #418 before mutation continues.
