# Capability Model

Capabilities describe what the selected backend can safely guarantee, not what
the editor might be able to do through undocumented automation.

Capabilities are split into `editor` and `analyzers` namespaces. For live Final
Cut, `editor.canonicalTimelineMode` is one of `metadata-only`,
`canonical-read`, or `canonical-write`. The mode is derived from the guarantees
below; a bridge cannot promote itself to `canonical-write` without complete
snapshot read, canonical mutation, read-after-write, and rollback. The current
Workflow Extension reports `metadata-only`: `editor.projectRead`,
`editor.liveStateRead`, and `editor.incrementalChanges` are enabled, while
complete snapshot and timeline writes remain disabled. An FCPXML document provider reports
`editor.timelineSnapshotRead` and `editor.timelineArtifactWrite`, never
`editor.timelineWrite`. Analyzer availability is negotiated independently.

Every disabled operation must fail with an explicit capability error. This is
preferable to returning partial state or reporting an unverified edit as
successful.

A live bridge that can safely provide canonical state uses the additive socket
methods `snapshot`, `apply`, and `restore`. `apply` and `restore` carry an
expected revision, so stale or mismatched targets fail before mutation. A
successful `apply` response returns the resulting revision so Framekit can
perform compensating rollback even when the subsequent snapshot read fails. Native
Accessibility operations remain a separate capability surface.
