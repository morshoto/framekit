# Drift detection and reconciliation

The runtime's `reconcileTimelineIr()` compares three provider-neutral values:

- `base`: the last state observed from the provider;
- `ours`: the agent's desired session state; and
- `theirs`: the provider's current state.

The merge is deterministic. An unchanged side yields the other side's value,
equal changes are accepted, and different changes to separate properties are
merged recursively. The collection order is the BASE order followed by
lexically ordered additions, so insertion order does not depend on which side
was inspected first.

The result is `rebased` with a complete merged IR or `conflicted` with
structured entity, identity, path, and BASE/OURS/THEIRS values. Delete-versus-
modify, different inserts with the same logical ID, duplicate IDs, target
changes, and invalid rational state fail closed. The reconciler never guesses
an occurrence identity and never applies last-writer-wins behavior.

`EditingSession.assertMaterializationReady()` rejects a provider revision that
differs from the session base and records `possibly_stale` until reconciliation
has happened. A successful rebase records `rebased`; callers can explicitly
call `markClean()` after verification, but it compares the desired content with
the current base. Because reconciliation preserves agent edits, the session
remains `dirty` when those edits have not yet been materialized. After native
materialization is verified, callers must refresh the base from the provider
before `markClean()` can record `clean`.
