# Capability Model

Capabilities describe what the selected backend can safely guarantee, not what
the editor might be able to do through undocumented automation.

## Versioned operation contract

`RuntimeCapabilities` retains the boolean `editor` and `analyzers` fields for
compatibility, and additionally exposes `schemaVersion: 1` with a `families`
object. Each family operation is a descriptor with four machine-readable
properties:

- `available` says whether the operation can be attempted safely.
- `backend` identifies the provider that owns that guarantee.
- `guarantee` describes the strongest proof the provider offers: `observed`,
  `artifact-write`, `canonical-read`, `canonical-write`, `native-verified`, or
  `verified`.
- `unavailableReason` is required when `available` is false and explains why
  the operation must fail closed.

The families are `connection`, `observation`, `canonicalDocument`, `native`,
`publishing`, `export`, and `analyzers`. The shape is intentionally additive so
older clients can continue reading the legacy booleans while new agents choose
one operation at a time:

```json
{
  "schemaVersion": 1,
  "families": {
    "connection": { "status": { "available": true, "backend": "workflow-extension-ipc", "guarantee": "observed" } },
    "observation": {
      "timeline": { "available": true, "backend": "workflow-extension-ipc", "guarantee": "observed" },
      "media": { "available": false, "backend": "workflow-extension-ipc", "guarantee": "none", "unavailableReason": "media observation is unavailable" }
    },
    "canonicalDocument": {
      "read": { "available": false, "backend": "workflow-extension-ipc", "guarantee": "none", "unavailableReason": "canonical timeline reads are unavailable" },
      "write": { "available": false, "backend": "workflow-extension-ipc", "guarantee": "none", "unavailableReason": "canonical timeline writes are unavailable" },
      "artifactWrite": { "available": false, "backend": "workflow-extension-ipc", "guarantee": "none", "unavailableReason": "canonical artifact writes are unavailable" }
    },
    "native": {
      "selectionWrite": { "available": false, "backend": "final-cut-accessibility", "guarantee": "none", "unavailableReason": "native selection write is unavailable" },
      "projectCreation": { "available": false, "backend": "final-cut-accessibility", "guarantee": "none", "unavailableReason": "native project creation is unavailable" },
      "clipInsertion": { "available": false, "backend": "final-cut-accessibility", "guarantee": "none", "unavailableReason": "native clip insertion is unavailable" },
      "clipMovement": { "available": false, "backend": "final-cut-accessibility", "guarantee": "none", "unavailableReason": "native clip movement is unavailable" },
      "titlePlacement": { "available": false, "backend": "final-cut-accessibility", "guarantee": "none", "unavailableReason": "native title placement is unavailable" }
    },
    "publishing": { "projectCreation": { "available": false, "backend": "fcpxml-publisher", "guarantee": "none", "unavailableReason": "new project publishing is unavailable" } },
    "export": { "timeline": { "available": false, "backend": "final-cut-native-export", "guarantee": "none", "unavailableReason": "timeline export is unavailable" } },
    "analyzers": { "speechTranscribe": { "available": false, "backend": "workflow-extension-ipc", "guarantee": "none", "unavailableReason": "speech transcription is unavailable" } }
  }
}
```

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

`connection.status` being `ready` only makes the connection descriptor
available. It never upgrades `canonicalDocument`, `native`, `publishing`, or
`export` operations; agents must inspect the corresponding family descriptor.

A live bridge that can safely provide canonical state uses the additive socket
methods `snapshot`, `apply`, and `restore`. `apply` and `restore` carry an
expected revision, so stale or mismatched targets fail before mutation. A
successful `apply` response returns the resulting revision so Framekit can
perform compensating rollback even when the subsequent snapshot read fails. Native
Accessibility operations remain a separate capability surface.
