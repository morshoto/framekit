# Capability Model

Capabilities describe what the selected backend can safely guarantee, not what
the editor might be able to do through undocumented automation.

For live Final Cut, `projectRead`, `liveSelection`, `livePlayhead`, and
`incrementalChanges` are enabled. `timelineRead`, `timelineWrite`,
`readAfterWrite`, `rollback`, analysis, playback, and asset discovery remain
disabled.

Every disabled operation must fail with an explicit capability error. This is
preferable to returning partial state or reporting an unverified edit as
successful.
