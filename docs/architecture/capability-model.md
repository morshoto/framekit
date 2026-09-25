# Capability Model

Capabilities describe what the selected backend can safely guarantee, not what
the editor might be able to do through undocumented automation.

For the current-version Final Cut non-UI snapshot decision and evidence, see the
[non-UI timeline snapshot investigation](./non-ui-timeline-snapshot-investigation.md).
The provider responsibilities and routing boundaries are summarized in the
[Final Cut provider boundaries](./final-cut-provider-boundaries.md) contract.

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
- Export descriptors may also include `evidenceTier`: `headed-native`,
  `background-native`, `artifact-rendered`, or `external-rendered`. This is
  separate from availability and prevents an external render from being
  presented as Final Cut-native output.
- `unavailableReason` is required when `available` is false and explains why
  the operation must fail closed.

The families are `connection`, `observation`, `canonicalDocument`, `editing`,
`native`, `publishing`, `export`, and `analyzers`. The observation family
contains `library`, `timeline`, `media`, and `assets` operations. The shape is
intentionally additive so older clients can continue reading the legacy
booleans while new agents choose one operation at a time:

```json
{
  "schemaVersion": 1,
  "families": {
    "connection": { "status": { "available": true, "backend": "workflow-extension-ipc", "guarantee": "observed" } },
    "observation": {
      "library": { "available": false, "backend": "final-cut-background-library", "guarantee": "none", "unavailableReason": "background library inspection is unavailable" },
      "timeline": { "available": true, "backend": "workflow-extension-ipc", "guarantee": "observed" },
      "media": { "available": false, "backend": "workflow-extension-ipc", "guarantee": "none", "unavailableReason": "media observation is unavailable" },
      "assets": { "available": false, "backend": "workflow-extension-ipc", "guarantee": "none", "unavailableReason": "asset discovery is unavailable" }
    },
    "canonicalDocument": {
      "read": { "available": false, "backend": "workflow-extension-ipc", "guarantee": "none", "unavailableReason": "canonical timeline reads are unavailable" },
      "write": { "available": false, "backend": "workflow-extension-ipc", "guarantee": "none", "unavailableReason": "canonical timeline writes are unavailable" },
      "artifactWrite": { "available": false, "backend": "workflow-extension-ipc", "guarantee": "none", "unavailableReason": "canonical artifact writes are unavailable" }
    },
    "editing": {
      "compositeTransactions": { "available": false, "backend": "workflow-extension-ipc", "guarantee": "none", "unavailableReason": "composite editing transactions are unavailable" },
      "titlePlacement": { "available": false, "backend": "workflow-extension-ipc", "guarantee": "none", "unavailableReason": "title placement is unavailable" },
      "pictureInPicture": { "available": false, "backend": "workflow-extension-ipc", "guarantee": "none", "unavailableReason": "picture-in-picture editing is unavailable" },
      "masking": { "available": false, "backend": "workflow-extension-ipc", "guarantee": "none", "unavailableReason": "masking is unavailable" },
      "personCutout": { "available": false, "backend": "workflow-extension-ipc", "guarantee": "none", "unavailableReason": "person cutout is unavailable" }
    },
    "native": {
      "selectionWrite": { "available": false, "backend": "final-cut-accessibility", "guarantee": "none", "unavailableReason": "native selection write is unavailable" },
      "projectCreation": { "available": false, "backend": "final-cut-accessibility", "guarantee": "none", "unavailableReason": "native project creation is unavailable" },
      "clipInsertion": { "available": false, "backend": "final-cut-accessibility", "guarantee": "none", "unavailableReason": "native clip insertion is unavailable" },
      "clipMovement": { "available": false, "backend": "final-cut-accessibility", "guarantee": "none", "unavailableReason": "native clip movement is unavailable" },
      "titlePlacement": { "available": false, "backend": "final-cut-accessibility", "guarantee": "none", "unavailableReason": "native title placement is unavailable" },
      "pictureInPicture": { "available": false, "backend": "final-cut-accessibility", "guarantee": "none", "unavailableReason": "native picture in picture is unavailable" }
    },
    "publishing": { "projectCreation": { "available": false, "backend": "fcpxml-publisher", "guarantee": "none", "unavailableReason": "new project publishing is unavailable" } },
    "export": {
      "timeline": { "available": false, "backend": "final-cut-native-export", "guarantee": "none", "unavailableReason": "timeline export is unavailable" },
      "background": { "available": false, "backend": "external-renderer", "guarantee": "none", "unavailableReason": "background rendering is unavailable" },
      "external": { "available": false, "backend": "external-renderer", "guarantee": "none", "unavailableReason": "external rendering is unavailable" }
    },
    "analyzers": { "speechTranscribe": { "available": false, "backend": "workflow-extension-ipc", "guarantee": "none", "unavailableReason": "speech transcription is unavailable" } }
  }
}
```

Capabilities are split into `editor` and `analyzers` namespaces. For live Final
Cut, `editor.canonicalTimelineMode` is one of `metadata-only`,
`canonical-read`, or `canonical-write`. The mode is derived from the guarantees
below; a bridge cannot promote itself to `canonical-write` without complete
snapshot read, canonical mutation, read-after-write, and rollback. The current
Workflow Extension reports `metadata-only`: `editor.projectRead` is disabled
because `project.inspect` has no canonical snapshot provider, while
`editor.liveStateRead` and `editor.incrementalChanges` remain enabled. An FCPXML document provider reports
`editor.timelineSnapshotRead` and `editor.timelineArtifactWrite`, never
`editor.timelineWrite`. Analyzer availability is negotiated independently.

Project targeting is also explicit. `editor.projectSelectionMode` is
`background-capable`, `headed-only`, or `unavailable`; the legacy
`editor.projectSelection` boolean remains for compatibility. A successful
`project.select` response includes the requested stable target, the observed
active target, and the observed context revision. The bundled Workflow
Extension reports `unavailable` because its public host surface exposes only
the active timeline sequence and no project catalog or activation command.

An optional background library provider may advertise catalog discovery without
advertising project selection or canonical timeline guarantees. Framekit keeps
the catalog source, live Workflow Extension revision/timing source, and
reconciliation status explicit. It returns active IDs only after stable project
and sequence IDs match across both observations; name-only matches and any
revision or target drift fail closed by returning unresolved/stale metadata.
Unresolved and stale results retain per-scope diagnostics for stable-ID
mismatch, ambiguous names, or unavailable identity, including the candidate
catalog IDs when a name is ambiguous. They also expose a
`target-selection-required` reconciliation blocker, and an unavailable
selection reason carries the same actionable context. These diagnostics are
provenance only and never change the metadata-only canonical capability
boundary.

The background library contract is explicit. A provider sets
`editor.backgroundLibraryInspection` to `true` and reports
`families.observation.library` with its provider identity. The bundled contract
uses backend `final-cut-background-library` and guarantee `observed`; this is
background metadata only, not canonical timeline evidence or native UI access.
`project.list` may route to this descriptor while `project.inspect`,
`timeline.inspect`, and native writes continue to require their own capabilities.

Route failures classify the missing proof as background API support, canonical
snapshot support, or native UI access. Each unavailable route preserves the
missing operation descriptor, including its backend, guarantee, and message.

Every disabled operation must fail with an explicit capability error. This is
preferable to returning partial state or reporting an unverified edit as
successful.

`connection.status` being `ready` only makes the connection descriptor
available. It never upgrades `canonicalDocument`, `native`, `publishing`, or
`export` operations; agents must inspect the corresponding family descriptor.

`families.export.timeline` is the headed-native Final Cut Share-menu path.
`families.export.background` and `families.export.external` are separate
capabilities. The current artifact-backed provider reports backend
`external-renderer` and `evidenceTier: "artifact-rendered"`; it does not make
the headed path background-native or advertise the separate external-rendered
capability.

A live bridge that can safely provide canonical state uses the additive socket
methods `snapshot`, `apply`, and `restore`. `apply` and `restore` carry an
expected revision, so stale or mismatched targets fail before mutation. A
successful `apply` response returns the resulting revision so Framekit can
perform compensating rollback even when the subsequent snapshot read fails. Native
Accessibility operations remain a separate capability surface.

## Inspect-time preflight

`editor.inspect` adds a top-level `preflight` report. It describes the effective
routed capabilities rather than only the identity of the composed editor:

```json
{
  "mode": "fcpxml-artifact",
  "documentMode": "fcpxml-artifact",
  "processMode": "headless",
  "backend": "final-cut-session",
  "capabilities": { "...": "the same operation-level family descriptors" }
}
```

`documentMode` distinguishes `fixture`, `fcpxml-artifact`, `metadata-only`, and
`canonical-live`. `mode` becomes `native-write` only for an explicitly headed
process with an available native write capability. A native-write report does not
promote metadata-only or artifact results to canonical evidence. Each operation
under `capabilities` retains its provider `backend`, `guarantee`, and, when
unavailable, `unavailableReason`. PIP and masking are independent operations:
the deterministic fixture supports verified rectangle and supplied-alpha masks,
and the native Accessibility provider supports a verified bounded Draw Mask.
Person cutout remains explicitly unavailable until a provider can perform and
read back that configuration.

Mask configurations are target-bound workflow operations. Rectangle masks use
normalized `x`, `y`, `width`, and `height` bounds that fit within the frame;
supplied-alpha masks require an explicit video `alphaMediaId`. Unsupported or
ambiguous targets fail closed before mutation, and verification compares the
requested configuration with the observed canonical or native state.
