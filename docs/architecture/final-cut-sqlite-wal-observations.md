# Final Cut SQLite/WAL observations

The #493 provider is a read-only evidence path for a known Framekit
materialization. It captures the SQLite database, optional `-wal`, and
optional `-shm` files, then compares storage fingerprints and the supported
structural rows before and after a controlled edit.

```text
known Framekit revision -> read-only DB/WAL/SHM capture
                         -> structural row/payload delta
                         -> proven mapping or explicit ambiguity
                         -> #417 reconciliation or #418 canonical resync
```

## Guarantees

- SQLite is opened with `-readonly` and `PRAGMA query_only=ON`.
- The provider never checkpoints, vacuums, writes, or mutates a Final Cut
  database, WAL, or SHM file.
- Captures bind to the requested project/sequence and the originating
  Framekit revision and artifact digest.
- Database, WAL, and SHM byte changes are recorded separately. Missing WAL or
  SHM files are explicit absence, not an empty semantic state.
- Collection and metadata row additions, removals, and modifications are
  preserved as structural evidence.

## Deliberate limits

Storage drift is not editor freshness: an unchanged database does not prove
that Final Cut flushed its in-memory state, and a changed WAL does not prove a
timeline operation. Archived `NSKeyedArchiver` payloads remain opaque unless a
version-gated, repeated corpus proves their meaning.

The initial controlled-operation matrix therefore marks trim, move, delete,
reorder, add, repeated occurrences, connected clips, markers, and project
rename as `not-observable`. No operation is promoted to a provider-neutral
Timeline IR observation by storage drift alone. Target mismatch, Final Cut
version drift, unexplained row changes, or ambiguous payload changes route to
canonical FCPXML resync (#418).

This is not `canonicalDocument.read`, not a complete timeline snapshot, and
not a passive proof of the latest Final Cut state. Native before/after
experiments may promote an operation only after repeated target-bound evidence
is captured and reviewed; until then the capability matrix remains explicit.
