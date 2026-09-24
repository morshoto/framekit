# Capabilities and Errors

The Final Cut provider split and routing boundary are summarized in the
[Final Cut provider boundaries](../architecture/final-cut-provider-boundaries.md)
contract.

## Editor-first routing

For canonical editing requests, call `connection.status`, `editor.inspect`,
and `project.inspect` in that order, then call `editing.route` with the
intended operation. Background metadata requests may route after
`editor.inspect`: `project.list` can use a background library descriptor and
`editor.live.inspect` can use observed timeline metadata without a canonical
snapshot. The route checks the operation's required capabilities against the
selected backend. A connected editor that cannot satisfy the operation returns
`CAPABILITY_UNAVAILABLE`; it is not silently replaced by an external renderer.

The route result is structured for deterministic handling:

```json
{
  "status": "external-fallback-selected",
  "selectedPath": "external-renderer",
  "missingCapabilities": ["editor.timelineSnapshotRead"],
  "reason": {
    "code": "EXTERNAL_FALLBACK_SELECTED",
    "cause": { "code": "CAPABILITY_UNAVAILABLE" }
  }
}
```

`external-renderer` is returned only when the caller explicitly selects
`fallback: "external-renderer"` or authorizes that fallback. The MCP server
reports why it was selected but does not invoke an external rendering pipeline.

Background metadata routing is explicit and preserves provider provenance:

```json
{
  "operation": "project.list",
  "status": "editor-selected",
  "selectedPath": "background",
  "provider": {
    "backend": "final-cut-background-library",
    "guarantee": "observed"
  },
  "missingCapabilities": []
}
```

An unavailable route includes `reason.unavailable.category`. The categories
name the missing evidence tier: `background-api` means background API support
is missing, `canonical-snapshot` means canonical snapshot support is missing,
and `native-ui` means native UI access is missing. The response also includes
the exact capability, provider backend, guarantee, and unavailable message.

Capabilities are machine-readable and backend-specific. A live-only Workflow
Extension reports:

## Versioned operation-level capabilities

`connection.status` and `editor.inspect` expose `capabilities.schemaVersion: 1`
and `capabilities.families`. Once the connection is ready, both tools use the
same composed runtime inspection, so their editor identity, capabilities, and
`preflight` report agree. The legacy `editor` and `analyzers` boolean namespaces
remain in the payload for compatibility. New clients should inspect the
descriptor for the exact operation they intend to use:

```json
{
  "available": false,
  "backend": "workflow-extension-ipc",
  "guarantee": "none",
  "unavailableReason": "canonical timeline writes are unavailable"
}
```

The descriptor means:

- `available`: the operation is safe to attempt under the current backend
  configuration.
- `backend`: the provider responsible for that operation; it may differ from
  the editor backend when a session composes FCPXML, Accessibility, publishing,
  export, or analyzer providers.
- `guarantee`: the strongest available proof (`observed`, `artifact-write`,
  `canonical-read`, `canonical-write`, `native-verified`, or `verified`).
- `unavailableReason`: a stable explanation required for unavailable
  operations; unavailable operations must fail with `CAPABILITY_UNAVAILABLE`.

When a capability-gated operation is rejected before its provider is called,
the MCP error preserves the complete operation descriptor as structured fields:

```json
{
  "code": "CAPABILITY_UNAVAILABLE",
  "message": "project.inspect requires canonicalDocument.read",
  "operation": "project.inspect",
  "capability": "canonicalDocument.read",
  "available": false,
  "backend": "workflow-extension-ipc",
  "guarantee": "none",
  "unavailableReason": "canonical timeline reads are unavailable"
}
```

`media.search` requires `capabilities.families.observation.media`. When that
descriptor is unavailable, the MCP tool returns an error payload that preserves
the capability's backend, guarantee, and unavailable reason instead of
attempting a canonical snapshot:

```json
{
  "code": "CAPABILITY_UNAVAILABLE",
  "message": "media.search requires observation.media",
  "operation": "media.search",
  "capability": "observation.media",
  "available": false,
  "backend": "workflow-extension-ipc",
  "guarantee": "none",
  "unavailableReason": "media observation is unavailable"
}
```

This unavailable result is distinct from a successful search with no matching
media, which remains the empty array `[]`.

Background media discovery is read-only and does not activate, focus, or
communicate with Final Cut. Configure one or more colon-separated local roots
with `FRAMEKIT_FINAL_CUT_MEDIA_ROOTS`; there are no implicit user media roots.
Results use IDs such as `filesystem:media:<absolute path>`, include a SHA-256
`sourceDigest`, file `sourceMetadata`, and
`discovery: { backend: "filesystem-media", source: "filesystem", guarantee: "observed" }`.
The descriptor's `backgroundMediaDiscovery` flag identifies this provider and
does not imply canonical timeline or native placement capability.

The families are:

| Family | Operation examples | Meaning |
| --- | --- | --- |
| `connection` | `status` | Bridge connection availability only |
| `observation` | `library`, `timeline`, `media`, `assets` | Background library metadata, live metadata, background discovery, or canonical observation |
| `canonicalDocument` | `read`, `write`, `artifactWrite` | Canonical timeline guarantees |
| `editing` | `compositeTransactions`, `titlePlacement`, `pictureInPicture`, `masking`, `personCutout` | Routed editing operations and explicit unsupported boundaries |
| `native` | `selectionWrite`, `titleDiscovery`, `titlePlacement`, `projectCreation`, `clipInsertion`, `clipMovement`, `pictureInPicture`, `masking` | Individual Final Cut Accessibility operations |
| `publishing` | `projectCreation` | Importing a verified artifact as a new project |
| `export` | `timeline`, `background`, `external` | Headed-native, background, and explicitly external verified video export paths |
| `analyzers` | `speechTranscribe`, `speechVad`, `audioLoudness`, `visualTrack` | Configured analysis providers |

Native operations are reported individually. An unsupported operation such as
project creation, clip insertion, or clip movement remains present with
`available: false` and an `unavailableReason`; a supported title placement or
media insertion operation does not imply that any other native operation is
available. Native masking is available only for the bounded Draw Mask path when
the adapter can read back its requested properties. `ready` is only a connection
state and never implies arbitrary editability.

`editor.assets` preserves its array response while attaching provider
provenance under each asset's `metadata.discovery`. Filesystem Motion-template
assets use `filesystem-motion-template`, stable IDs such as
`filesystem:title:<absolute path>`, and `metadata.installation` with the bundle
`path`, configured `root`, and `relativePath`. The default
`discovery: "background"` query never calls the native Browser provider.
`discovery: "native"` explicitly requests headed Titles or Transitions Browser
discovery; `discovery: "all"` retains the composed compatibility behavior.
Native results use `final-cut-accessibility` and stable IDs such as
`final-cut:title:<AXIdentifier>` or `final-cut:transition:<AXIdentifier>`.
Discovery has an `observed` guarantee and is not placement proof. Native title
and transition placement require a final-cut-qualified identity plus explicit
targets, timing, revision, and readback verification. Filesystem assets may be
used for artifact workflows only when their source identity and digest are
bound; native placement must revalidate a native asset identity. If a native
browser or Accessibility is unavailable, composed results may include
`metadata.discovery.native` with the native backend, `guarantee: "none"`, and
`unavailableReason`; native-only queries fail closed instead of inventing an
asset. The `backgroundTemplateDiscovery` flag identifies the filesystem
provider and does not imply native placement capability.

`editor.inspect` also returns an inspect-time `preflight` report. Its `mode` is
`fixture`, `fcpxml-artifact`, `metadata-only`, `canonical-live`, or
`native-write`; `documentMode` preserves the underlying document mode when a
headed native-write surface is active. `processMode` is `headed` or `headless`.
The report includes `fingerprint.version` for the Framekit package and
`fingerprint.commit` for the source build. The commit comes from
`FRAMEKIT_BUILD_COMMIT` when supplied, otherwise from the checked-out Git
repository; packaged builds without either source should report `unknown`.
The report repeats the effective `capabilities` families so agents can see the
backend, guarantee, and unavailable reason for connection, canonical reads and
writes, composite editing, speech, audio, visual analysis, title placement, PIP,
and masking in one response. `native-write` is only reported for an explicitly
headed process with a native write capability; deterministic, metadata-only, and
FCPXML artifact results remain separate evidence tiers.

```json
{
  "editor": {
    "canonicalTimelineMode": "metadata-only",
    "projectRead": false,
    "timelineSnapshotRead": false,
    "timelineWrite": false,
    "timelineArtifactWrite": false,
    "readAfterWrite": false,
    "incrementalChanges": true,
    "rollback": false,
    "backgroundLibraryInspection": false,
    "assetDiscovery": false,
    "backgroundMediaDiscovery": false,
    "backgroundTemplateDiscovery": false,
    "liveStateRead": true,
    "playheadWrite": false,
    "frameCapture": false,
    "playbackControl": false
  },
  "analyzers": {
    "speechTranscribe": false,
    "speechVad": false,
    "audioLoudness": false,
    "visualTrack": false,
    "metadataDescribe": false
  }
}
```

`canonical-read` requires a complete project/timeline snapshot with stable
project, sequence, media, and occurrence identities plus explicit project
catalog and sequence-selection guarantees. `canonical-write` additionally
requires revision-guarded mutation, read-after-write, and rollback. A successful
canonical apply returns the resulting revision so read failures can be rolled
back without guessing the current editor revision.
The mode is returned by both `connection.status` and `editor.inspect` for live
backends.

When `FRAMEKIT_FCPXML_PATH` is configured, the composed Final Cut session also
reports `timelineSnapshotRead`, `timelineArtifactWrite`, `readAfterWrite`, and
`rollback` as true. `timelineWrite` remains false because edits update the
managed FCPXML artifact rather than the open Final Cut timeline. Analyzer flags
are true only for configured local analyzer commands, and `assetDiscovery` is
true when the Motion-template registry is available. `metadataDescribe` is
true only when a metadata provider is configured. Combined media understanding
reports each missing or failed analyzer as an unavailable status and leaves
that modality out of the semantic description.

When `FRAMEKIT_FINAL_CUT_MEDIA_ROOTS` is configured, the session also reports
`backgroundMediaDiscovery` and `observation.media` for the filesystem provider.
When a Motion-template registry is available, it reports
`backgroundTemplateDiscovery` and `observation.assets` for filesystem
discovery. Both are observed metadata capabilities; neither activates Final
Cut or upgrades filesystem results to canonical-live or headed-native evidence.

When a background Final Cut library provider is available, the session reports
`backgroundLibraryInspection` and `observation.library` with backend
`final-cut-background-library` and guarantee `observed`. This provider may serve
`project.list` while Final Cut is not frontmost, but it does not provide
canonical timeline evidence, canonical snapshot support, project selection, or
native UI access. A missing provider returns an unavailable descriptor rather
than an empty or invented catalog.

`artifactPublish` is true only when the MCP server has a configured headed
project publisher with native writes enabled. `artifactPublishMode` reports
`headed-only` for that guarded path and `unavailable` when it is not enabled;
the current implementation does not advertise a background-capable mode. The
job tools remain available when a managed artifact is configured so callers can
prepare and inspect a no-UI handoff. `artifactPublish` is separate from both
`timelineArtifactWrite` and `timelineWrite` because importing an artifact as a
new project is neither an artifact edit nor an edit of the open timeline.

`frameCapture` is true only when the selected editor backend has an actual
frame-image provider. `timeline.frame.capture` never fabricates an image: it
returns `CAPABILITY_UNAVAILABLE` when capture is missing, and does the same for
requested visual analysis when no visual analyzer is configured.

Important error codes include:

- `CAPABILITY_UNAVAILABLE`: the backend cannot safely perform the operation.
- `FINAL_CUT_LIVE_UNAVAILABLE`: the live socket cannot be reached.
- `FINAL_CUT_LIVE_TIMEOUT`: the bridge did not respond in time.
- `FINAL_CUT_ACTIVATION_TIMEOUT`: Final Cut did not complete Workflow Extension activation before the bounded connection deadline.
- `FINAL_CUT_NATIVE_APPLE_EVENT_TIMEOUT`: Final Cut did not respond to a native AppleEvent; reopen or bring Final Cut Pro to the front and retry.
- `FINAL_CUT_LIVE_PROTOCOL`: framing, JSON, or version failure.
- `EDITOR_NOT_CONNECTED`: no usable editor backend is connected.
- `STALE_CONTEXT`: an edit or undo used an old revision.
- `TARGET_MISMATCH`: restore or undo targets a different project or sequence
  from the active editor target.
- `ANALYZER_MEDIA_UNAVAILABLE`: the configured analyzer cannot read the media source.
- `ANALYZER_TIMEOUT`: a configured analyzer exceeded its time limit.
- `ANALYZER_FAILED`: a configured analyzer exited unsuccessfully.
- `ANALYZER_INVALID_OUTPUT`: a configured analyzer returned invalid typed JSON.
- `FINAL_CUT_EXPORT_COMPLETION_TIMEOUT`: Final Cut did not produce a non-empty output file before the export deadline.
- `FINAL_CUT_EXPORT_OUTPUT_EXISTS`: an existing output was protected from replacement without `overwrite: true`.
- `FINAL_CUT_EXPORT_VERIFICATION_FAILED`: the output media metadata was missing, invalid, or did not match requested expectations.
- `FINAL_CUT_EXPORT_METADATA_FAILED`: `ffprobe` could not inspect the exported video.
- `FINAL_CUT_EXPORT_METADATA_UNAVAILABLE`: `ffprobe` was not available before export started.
- `FINAL_CUT_EXPORT_COMMIT_FAILED`: the verified staging file could not be moved to the requested output path.
- `AMBIGUOUS_MASK_TARGET`: more than one timeline occurrence matched the mask target.
- `FINAL_CUT_NATIVE_MASK_READBACK_UNAVAILABLE`: Final Cut did not expose readable Draw Mask properties.
- `FINAL_CUT_NATIVE_VERIFICATION_FAILED`: native mask properties, revision, target, or Undo verification failed; the adapter attempts native rollback when safe.

Music mixing reports `CAPABILITY_UNAVAILABLE: dialogue ducking` when a request
asks for automatic dialogue ducking. Gain and fades are verified for the
deterministic composite workflow, but ducking must not be silently approximated
with a fixed music gain.

## Connection status

The `connection.status` MCP tool is available while the live bridge is being
installed or activated. It returns a state such as `launching`,
`waiting-for-socket`, `ready`, `needs-user-action`, or `unavailable`, together
with the detected editor, extension path, socket path, last error, and—when a
bridge is ready—the same effective versioned capability and `preflight` payload
as `editor.inspect`. A `ready` state only means that the bridge answered;
inspect each operation family before editing.

`project.inspect` and `timeline.inspect` check `canonicalDocument.read` before
asking the runtime for a snapshot. `media.search` checks `observation.media`
before searching. When either operation is unavailable, the MCP result is an error with
`code: "CAPABILITY_UNAVAILABLE"`, the operation name, the descriptor backend,
guarantee, and `unavailableReason`; an unavailable search is never represented
as an empty successful result.

The MCP process remains available while setup is in progress. Live editor tools
remain fail-closed until the status becomes `ready`; the server never silently
switches to the deterministic fixture.

The runtime must not fabricate empty timelines, pretend a write succeeded, or
fall back to fixture data without reporting that decision.

## Native UI capabilities

Native selection edits are reported separately from canonical editor
capabilities:

```json
{
  "native": {
    "selectionEdit": true,
    "undo": true,
    "mediaLibrarySearch": true,
    "mediaImport": true,
    "mediaSelection": true,
    "timelineOccurrenceLocate": true,
    "pictureInPicture": true,
    "bladeAtPlayhead": true,
    "deleteRange": true,
    "trimToDuration": true,
    "timelineFocus": true,
    "masking": true,
    "requiresAccessibility": true,
    "requiresFinalCutFrontmost": true
  }
}
```

They are disabled unless `FRAMEKIT_FINAL_CUT_NATIVE_WRITES=1`. Native edits
operate on the active Final Cut selection/playhead and do not claim a complete
timeline snapshot or canonical diff.

The operation-level `capabilities.families.native` descriptors are the
machine-readable form of this surface. They include every supported native
operation plus explicit entries for unsupported project creation, clip
insertion, and clip movement. The legacy `native` object above remains for
compatibility.

Native PIP is a headed-only operation. Its preview binds a selected Browser
media handle, a unique timeline occurrence handle, the live sequence revision,
and an explicit frame-aligned range. Execute connects the Browser video on a
non-primary lane, applies the requested transform/crop/frame, reads those
properties back from the Video Inspector, and retains Final Cut's native Undo
command. A successful native PIP result is headed-native evidence; it is not a
canonical snapshot, diff, or masking/person-cutout capability.

`bladeAtPlayhead` splits the current uniquely identified occurrence but does not
shorten the sequence. `deleteRange` ripple-deletes an explicit rational range
from the primary storyline. `trimToDuration` preserves the beginning of the
sequence and deletes its tail after the requested duration. The latter two
operations require preview/execute confirmation and verify the resulting live
sequence duration.

`masking` is a separate native operation. Its preview is bound to a unique
occurrence handle and current revision. Execute applies only a bounded Draw
Mask, requires exact property readback, verifies a new revision and Undo
command, and rolls back the native edit when verification fails. The native
surface does not advertise person cutout or tracking without equivalent
readback.

Native errors include `FINAL_CUT_NATIVE_PERMISSION_REQUIRED`,
`FINAL_CUT_NATIVE_NO_TIMELINE_WINDOW`, `FINAL_CUT_NATIVE_NOT_FRONTMOST`,
`FINAL_CUT_NATIVE_TIMELINE_FOCUS_REQUIRED`,
`FINAL_CUT_NATIVE_SELECTION_REQUIRED`,
`FINAL_CUT_NATIVE_MODAL_BLOCKED`, `FINAL_CUT_NATIVE_COMMAND_UNAVAILABLE`,
`FINAL_CUT_NATIVE_VERIFICATION_FAILED`,
`FINAL_CUT_NATIVE_UNDO_UNAVAILABLE`,
`FINAL_CUT_NATIVE_UNDO_UNBOUND`,
`FINAL_CUT_NATIVE_MUTATION_EVIDENCE_UNAVAILABLE`,
`FINAL_CUT_NATIVE_TARGET_BINDING_UNAVAILABLE`,
`FINAL_CUT_NATIVE_TARGET_CHANGED`,
`FINAL_CUT_NATIVE_PARTIAL_MUTATION`,
`FINAL_CUT_NATIVE_UNDO_STALE`,
`FINAL_CUT_NATIVE_UNDO_COMMAND_CHANGED`, and
`FINAL_CUT_NATIVE_UNDO_VERIFICATION_FAILED`. Native context diagnostics expose
the operation-specific `undoCommand` when Final Cut has an enabled Undo item.

When a native command has already changed Final Cut but its post-command
verification or rollback proof is incomplete, mutation tools return a
structured `FINAL_CUT_NATIVE_PARTIAL_MUTATION` error. Its `details` include
the session-scoped `operationId`, `recoveryHandle`, `safeToRetry: false`, the
`editor.native.undo` recovery tool, and revision/project/sequence/target/Undo
evidence. Do not retry the edit; use the returned operation ID for recovery and
verify restoration before continuing.

```json
{
  "code": "FINAL_CUT_NATIVE_PARTIAL_MUTATION",
  "details": {
    "operationId": "native-op-...",
    "recoveryHandle": "native-op-...",
    "mutationApplied": true,
    "safeToRetry": false,
    "recovery": { "tool": "editor.native.undo", "operationId": "native-op-..." },
    "evidence": { "revisionAdvanced": true, "targetBound": true }
  }
}
```
Range operations additionally use
`FINAL_CUT_NATIVE_RANGE_OUT_OF_BOUNDS` and
`FINAL_CUT_NATIVE_PLAYHEAD_VERIFICATION_FAILED` and
`FINAL_CUT_NATIVE_PREVIEW_STALE`. Live discovery and Blade additionally
use `FINAL_CUT_NATIVE_MEDIA_HANDLE_STALE`,
`FINAL_CUT_NATIVE_OCCURRENCE_HANDLE_STALE`,
`FINAL_CUT_NATIVE_PREVIEW_STALE`, and
`FINAL_CUT_NATIVE_SELECTION_VERIFICATION_FAILED`. Local media import additionally
uses `FINAL_CUT_NATIVE_MEDIA_PATH_UNAVAILABLE`,
`FINAL_CUT_NATIVE_MEDIA_IMPORT_TIMEOUT`,
`FINAL_CUT_NATIVE_MEDIA_IMPORT_DISCOVERY_TIMEOUT`, and
`FINAL_CUT_NATIVE_MEDIA_IMPORT_UI_UNAVAILABLE`,
`FINAL_CUT_NATIVE_MEDIA_IMPORT_AMBIGUOUS`,
`FINAL_CUT_NATIVE_MEDIA_IMPORT_PRE_EXISTING`, and
`FINAL_CUT_NATIVE_MEDIA_IMPORT_IDENTITY_UNAVAILABLE`. Passing a readable
directory to the single-file import returns the structured
`FINAL_CUT_NATIVE_MEDIA_DIRECTORY_INPUT` error with `guidance.previewTool` and
`guidance.executeTool` pointing to the directory workflow. Directory discovery
and batch import additionally use `FINAL_CUT_NATIVE_MEDIA_DIRECTORY_UNAVAILABLE`,
`FINAL_CUT_NATIVE_MEDIA_FILE_UNAVAILABLE`,
`FINAL_CUT_NATIVE_CONFIRMATION_REQUIRED`, and
`FINAL_CUT_NATIVE_PREVIEW_STALE`.

`editor.native.inspect` runs a bounded, passive UI preflight. It reads the
frontmost application, accessible timeline window, current focus, target, and
Framekit overlay state without activating Final Cut, raising or minimizing
windows, clicking, or changing selection. Its `readiness` object is structured
for callers that need to decide whether to retry or request an explicit native
write:

```json
{
  "state": "unavailable",
  "nextAction": "retry",
  "retryable": true,
  "firstMissing": "frontmost",
  "frontmost": false,
  "timelineFocus": false,
  "selectedTarget": true,
  "overlay": "unknown",
  "permission": "granted",
  "undo": "available",
  "guidance": "Bring Final Cut Pro to the front and retry"
}
```

`state` distinguishes `ready`, `unavailable`, `timeout`, `cancelled`, and
`stale`; `nextAction` is `none`, `retry`, `queue`, or `unavailable`. Native
errors retain stable codes and include the same state and retryability where a
context is returned, so timeout, cancellation, unavailable capability, and
stale preview/handle failures remain distinguishable in the MCP contract.

Explicit `editor.native.focus` and timeline-native preview/execute operations
use the active UI preflight: they may activate Final Cut, minimize an
overlapping Framekit overlay with `AXMinimize`, raise Final Cut's timeline
window, and re-check focus after every attempt. If the overlay cannot be
minimized or remains focused, the operation fails closed with
`FINAL_CUT_NATIVE_OVERLAY_BLOCKED`. Native writes also fail closed with
`FINAL_CUT_NATIVE_NO_TIMELINE_WINDOW`, `FINAL_CUT_NATIVE_NOT_FRONTMOST`, or
`FINAL_CUT_NATIVE_TIMELINE_FOCUS_REQUIRED` when their required UI state is
missing. Both tools include `timelineWindowAvailable`, `timelineFocused`,
`focusTarget`, `focusedWindowName`, `framekitWindowAvailable`,
`framekitWindowMinimized`, `overlayBlocked`, and focus-attempt diagnostics. The
focus tool changes application focus only; it does not select a project or
mutate timeline content, and it never clicks the Framekit close button.

`artifact.publish` is reported separately from `timelineWrite`. It accepts a
verified artifact transaction, matching `artifactPath`, and `confirm: true` to
import a new Final Cut project. Its result identifies the source artifact,
created project/sequence, and active project before/after; it does not mean the
currently open timeline is directly writable. Missing confirmation fails with
`PUBLISH_CONFIRMATION_REQUIRED`, and a mismatched artifact fails with
`PUBLISH_TARGET_MISMATCH`.

The job-based `artifact.publish.preview`, `artifact.publish.execute`, and
`artifact.publish.status` tools make the headed-only boundary explicit. They
return `awaiting-final-cut` when no headed provider is available and
`verification-pending` when an import may have started but live readback is
temporarily unavailable. A retry of the latter verifies the existing import
and does not import the artifact again. Only `verified` includes a
`createdTarget`.

`videoExport` is reported separately from canonical timeline capabilities. It is
true only when the live server has enabled the guarded native Final Cut export
adapter with `FRAMEKIT_FINAL_CUT_NATIVE_WRITES=1` and a usable `ffprobe`; deterministic
fixtures do not claim to render video. `timeline.export` supports the `master`
(`Export File`) and `web` (`Web Hosting`) Final Cut share presets. It waits for a
stable non-empty file, probes it with `ffprobe`, and verifies duration, width,
height, frame rate, and audio presence before returning success. Export performs
the same native timeline-window/frontmost/focus preflight as other guarded UI
operations. An existing file is preserved until the replacement has passed
verification and is never replaced unless the request explicitly sets
`overwrite: true`.

Background and external rendering are reported separately as
`editor.backgroundRender`, `editor.externalRender`, and the
`families.export.background` / `families.export.external` descriptors. The
current background provider is an injected external renderer over an explicit
artifact source; it reports `backend: "external-renderer"` and
`evidenceTier: "artifact-rendered"`. The separate external-rendered capability
remains unavailable until a supported source can provide that evidence. It does
not invoke Final Cut UI, does not claim native semantic equivalence, and does
not change the headed `timeline.export` capability.
