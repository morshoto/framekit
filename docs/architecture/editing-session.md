# Provider-neutral editing session

`@framekit/runtime` owns the versioned Timeline IR in
`packages/runtime/src/timeline/editing-session.ts`. It is deliberately
independent of MCP and Final Cut adapter modules.

## Model

An `EditingSession` stores two complete IR values:

- `base` is the last provider snapshot used to start the session.
- `desired` is the agent's current planned state.

Both values use exact `RationalTime` strings for sequence, occurrence, story
element, marker, and caption coordinates. Occurrence IDs are logical timeline
identities, separate from resource IDs. Provider-specific identities are
optional `TimelineIrBinding` values attached at the edge of the model.

The document is JSON-serializable with `schemaVersion: 1`. Loading validates
the schema, target identity, rational values, uniqueness, resource references,
and bindings before returning a session.

## Headless workflow

`EditingSession.preview()` applies supported operations to a clone and returns
the complete resulting IR without mutating the session. `apply()` repeats the
same operation against the expected desired revision and then advances the
desired revision. The supported deterministic operations are rename, trim,
move, gain, remove, and marker insertion. These operations do not call an
editor or require Final Cut to be running. A provider revision observed after
the session BASE marks the session `possibly_stale`; preview and apply reject
the plan before changing OURS/desired until reconciliation supplies THEIRS.

Session states are explicit: `clean`, `dirty`, `possibly_stale`, `conflicted`,
`rebased`, and `waiting_for_materialization`. A stale revision is rejected
before any desired state changes. No operation performs automatic conflict
resolution; reconciliation belongs to the dependent drift feature.
