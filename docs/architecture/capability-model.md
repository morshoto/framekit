# Capability Model

Capabilities describe what the selected backend can safely guarantee, not what
the editor might be able to do through undocumented automation.

Capabilities are split into `editor` and `analyzers` namespaces. For live Final
Cut, `editor.projectRead`, `editor.liveStateRead`, and
`editor.incrementalChanges` are enabled; complete snapshot and timeline writes
remain disabled. An FCPXML document provider reports
`editor.timelineSnapshotRead` and `editor.timelineArtifactWrite`, never
`editor.timelineWrite`. Analyzer availability is negotiated independently.

Every disabled operation must fail with an explicit capability error. This is
preferable to returning partial state or reporting an unverified edit as
successful.
