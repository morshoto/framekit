# Compatibility Matrix

Phase 0, Phase 1, and Phase 2 are local runtime spikes. Capability declarations are
authoritative at runtime; unsupported operations must fail with an explicit
`CAPABILITY_UNAVAILABLE` error.

| Adapter | Backend | Project read | Timeline write | Read-after-write | Rollback | Speech/audio | Visual | Frame capture | Native assets |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| In-memory fixture | deterministic test fixture | yes | yes | yes | yes | fixture providers | fixture provider | fixture provider | fixture assets |
| Final Cut document | FCPXML file interchange | yes, with project and sequence UIDs | artifact only | yes | yes | external provider required | no | no | no |
| Final Cut session | document + Workflow Extension | document provider | artifact only | document provider | document provider | configured local provider | configured local provider | unavailable until configured | Motion-template registry |
| Final Cut live (bundled Workflow Extension) | Workflow Extension live IPC | active project/sequence metadata only; catalog/selection unavailable | no | no | no | no | no | no | no |
| Final Cut live (canonical-capable bridge) | guarded live IPC provider contract | complete snapshot with explicit targets | yes, when canonical-write is advertised | yes | yes | provider-specific | provider-specific | provider-specific | provider-specific |

The canonical-capable live row describes an optional provider contract, not a
claim about the bundled Workflow Extension. The bundled bridge remains
metadata-only until a real Final Cut bridge can enumerate and mutate the open
timeline and pass the headed evidence gate documented in
[`docs/tests/final-cut-live-e2e.md`](tests/final-cut-live-e2e.md).

## Editing surface semantics

The editing surfaces are deliberately target-specific. Callers choose the
surface before mutation and must be able to identify the object that will be
changed.

| Surface | Target | Revision | Read-after-write | Undo | Resulting project state |
| --- | --- | --- | --- | --- | --- |
| `artifact.edit` | Managed FCPXML artifact ID and path | Artifact snapshot revision | Reads the same artifact after the write | Restores the artifact transaction | Updates the FCPXML artifact; it does not claim to change the open Final Cut project |
| `artifact.publish` | Verified artifact path and source transaction | Verified source transaction plus `confirm: true` | Reports the created project/sequence and active project before/after | Does not undo the imported project through artifact undo | Creates/imports a new Final Cut project and never silently replaces the active project |
| `editor.timeline.edit` | Explicit active project ID and sequence ID | Required live base revision | Reads the identified live timeline after the write | Restores the identified live timeline transaction | Changes the selected live project only when canonical live-write capability is available |

An artifact edit and a live timeline edit are not interchangeable, even when
they describe the same project name. An ambiguous or unsupported target fails
closed before mutation.

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
It uses non-empty FCPXML `uid` attributes as the only stable project and
sequence identities. UID-less documents fail closed with
`FCPXML_PROJECT_IDENTITY_UNAVAILABLE` or
`FCPXML_SEQUENCE_IDENTITY_UNAVAILABLE`; names are never used as ID fallbacks.
Renaming a UID-backed project or sequence therefore does not change its ID.
The session adapter composes independent snapshot, mutation, live-state,
analyzer, and asset ports. The Workflow Extension backend is a separate
live-state port: it exposes active project metadata and a project-scoped
sequence identity derived from the current sequence name, plus playhead,
selected range, and observer-backed change events. The sequence identity is
not an immutable host identifier; native handles fail closed when it changes.
It reports
`timelineSnapshotRead: false` because the public Workflow Extension proxy does
not guarantee complete clip/media enumeration. The composed session enables
canonical operations only when `FRAMEKIT_FCPXML_PATH` is supplied.

Native selection and media-library operations are separate MCP capabilities.
They use Accessibility automation, require `FRAMEKIT_FINAL_CUT_NATIVE_WRITES=1`,
and do not change the canonical `timelineWrite` or `timelineSnapshotRead`
capability flags. With the same opt-in, the native path can import local video or
audio, wait for the asset to appear in the active Browser, return a stable
session media handle, search/select Browser media, locate a unique timeline
occurrence, Blade it at the playhead, and add a discovered native title with
text at the playhead or an explicit range. Imported media handles are session
stable; timeline occurrence and native title operation handles remain short-lived
and are not canonical timeline identities. Native title placement is reported
separately as `titlePlacement` and never upgrades the live Workflow Extension's
canonical timeline capabilities.

When both `FRAMEKIT_FCPXML_PATH` and native writes are configured,
`artifact.publish` accepts a verified artifact transaction, its managed
`artifactPath`, and explicit `confirm: true` before importing a new Final Cut
project. It reports the created project target and active project before/after;
the active project is never replaced automatically.

With native writes enabled, the live server also exposes `timeline.export` for
rendering the active Final Cut timeline to a local video file. This separate
capability requires `ffprobe`; it verifies file completion and media metadata
and does not make the FCPXML artifact or live timeline canonically writable.

## Phase 2 local runtime

The deterministic fixture provides the Phase 2 context engine, including
incremental change feeds, visual analysis, combined media understanding, and
queryable native assets. It also provides deterministic frame images for exact
rational timeline positions, including timecode and active-clip metadata. These
are replaceable ports. Final Cut can provide
the same contracts through configured local JSON analyzers and filesystem
Motion-template discovery; no fixture data is injected into live mode.

The live server also supports `--headless`. In that mode it probes an existing
Workflow Extension socket without launching or activating Final Cut and keeps
native UI writes disabled. Headless validation covers the native contracts
through deterministic executors; it does not mutate the open Final Cut UI.
