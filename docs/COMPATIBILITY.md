# Compatibility Matrix

Phase 0, Phase 1, and Phase 2 are local runtime spikes. Capability declarations are
authoritative at runtime; unsupported operations must fail with an explicit
`CAPABILITY_UNAVAILABLE` error.

| Adapter | Backend | Project read | Timeline write | Read-after-write | Rollback | Speech/audio | Visual | Native assets |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| In-memory fixture | deterministic test fixture | yes | yes | yes | yes | fixture providers | fixture provider | fixture assets |
| Final Cut document | FCPXML file interchange | yes | artifact only | yes | yes | external provider required | no | no |
| Final Cut session | document + Workflow Extension | document provider | artifact only | document provider | document provider | configured local provider | configured local provider | Motion-template registry |
| Final Cut live | Workflow Extension live IPC | project/sequence metadata only | no | no | no | no | no | no |

## Verified local environment

The live Workflow Extension path was verified on 2026-08-16 with:

| Component | Version |
| --- | --- |
| macOS | 26.5.1 |
| Final Cut Pro | 10.7.1 |
| Xcode | 16.4 (16F6) |
| macOS SDK | 15.5 |

This is a local verification record, not a claim that every nearby editor or
OS version is supported.

The FCPXML adapter is intentionally not a live Final Cut automation backend.
The session adapter composes independent snapshot, mutation, live-state,
analyzer, and asset ports. The Workflow Extension backend is a separate
live-state port: it exposes active project/sequence metadata, playhead,
selected range, and observer-backed change events. It reports
`timelineSnapshotRead: false` because the public Workflow Extension proxy does
not guarantee complete clip/media enumeration. The composed session enables
canonical operations only when `FRAMEKIT_FCPXML_PATH` is supplied.

Native selection writes are a separate MCP capability. They use Accessibility
automation, require `FRAMEKIT_FINAL_CUT_NATIVE_WRITES=1`, and do not change the
canonical `timelineWrite` or `timelineSnapshotRead` capability flags.

## Phase 2 local runtime

The deterministic fixture provides the Phase 2 context engine, including
incremental change feeds, visual analysis, combined media understanding, and
queryable native assets. These are replaceable ports. Final Cut can provide
the same contracts through configured local JSON analyzers and filesystem
Motion-template discovery; no fixture data is injected into live mode.
