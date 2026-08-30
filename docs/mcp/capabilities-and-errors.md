# Capabilities and Errors

Capabilities are machine-readable and backend-specific. A live-only Workflow
Extension reports:

```json
{
  "editor": {
    "canonicalTimelineMode": "metadata-only",
    "projectRead": true,
    "timelineSnapshotRead": false,
    "timelineWrite": false,
    "timelineArtifactWrite": false,
    "readAfterWrite": false,
    "incrementalChanges": true,
    "rollback": false,
    "assetDiscovery": false,
    "liveStateRead": true,
    "playheadWrite": false,
    "frameCapture": false,
    "playbackControl": false
  },
  "analyzers": {
    "speechTranscribe": false,
    "speechVad": false,
    "audioLoudness": false,
    "visualTrack": false
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
true when the Motion-template registry is available.

`artifactPublish` is true only when the MCP server has a configured project
publisher with native writes enabled. It is separate from both
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
- `STALE_CONTEXT`: an edit used an old revision.
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

Music mixing reports `CAPABILITY_UNAVAILABLE: dialogue ducking` when a request
asks for automatic dialogue ducking. Gain and fades are verified for the
deterministic composite workflow, but ducking must not be silently approximated
with a fixed music gain.

## Connection status

The `connection.status` MCP tool is available while the live bridge is being
installed or activated. It returns a state such as `launching`,
`waiting-for-socket`, `ready`, `needs-user-action`, or `unavailable`, together
with the detected editor, extension path, socket path, and last error.

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
    "bladeAtPlayhead": true,
    "deleteRange": true,
    "trimToDuration": true,
    "timelineFocus": true,
    "requiresAccessibility": true,
    "requiresFinalCutFrontmost": true
  }
}
```

They are disabled unless `FRAMEKIT_FINAL_CUT_NATIVE_WRITES=1`. Native edits
operate on the active Final Cut selection/playhead and do not claim a complete
timeline snapshot or canonical diff.

`bladeAtPlayhead` splits the current uniquely identified occurrence but does not
shorten the sequence. `deleteRange` ripple-deletes an explicit rational range
from the primary storyline. `trimToDuration` preserves the beginning of the
sequence and deletes its tail after the requested duration. The latter two
operations require preview/execute confirmation and verify the resulting live
sequence duration.

Native errors include `FINAL_CUT_NATIVE_PERMISSION_REQUIRED`,
`FINAL_CUT_NATIVE_NO_TIMELINE_WINDOW`, `FINAL_CUT_NATIVE_NOT_FRONTMOST`,
`FINAL_CUT_NATIVE_TIMELINE_FOCUS_REQUIRED`,
`FINAL_CUT_NATIVE_SELECTION_REQUIRED`,
`FINAL_CUT_NATIVE_MODAL_BLOCKED`, `FINAL_CUT_NATIVE_COMMAND_UNAVAILABLE`,
`FINAL_CUT_NATIVE_VERIFICATION_FAILED`,
`FINAL_CUT_NATIVE_UNDO_UNAVAILABLE`,
`FINAL_CUT_NATIVE_UNDO_STALE`,
`FINAL_CUT_NATIVE_UNDO_COMMAND_CHANGED`, and
`FINAL_CUT_NATIVE_UNDO_VERIFICATION_FAILED`. Native context diagnostics expose
the operation-specific `undoCommand` when Final Cut has an enabled Undo item.
Range operations additionally use
`FINAL_CUT_NATIVE_RANGE_OUT_OF_BOUNDS` and
`FINAL_CUT_NATIVE_PLAYHEAD_VERIFICATION_FAILED` and
`FINAL_CUT_NATIVE_PREVIEW_STALE`. Live discovery and Blade additionally
use `FINAL_CUT_NATIVE_MEDIA_HANDLE_STALE`,
`FINAL_CUT_NATIVE_OCCURRENCE_HANDLE_STALE`,
`FINAL_CUT_NATIVE_PREVIEW_STALE`, and
`FINAL_CUT_NATIVE_SELECTION_VERIFICATION_FAILED`. Local media import additionally
uses `FINAL_CUT_NATIVE_MEDIA_PATH_UNAVAILABLE`,
`FINAL_CUT_NATIVE_MEDIA_IMPORT_TIMEOUT`, and
`FINAL_CUT_NATIVE_MEDIA_IMPORT_UI_UNAVAILABLE`,
`FINAL_CUT_NATIVE_MEDIA_IMPORT_AMBIGUOUS`,
`FINAL_CUT_NATIVE_MEDIA_IMPORT_PRE_EXISTING`, and
`FINAL_CUT_NATIVE_MEDIA_IMPORT_IDENTITY_UNAVAILABLE`.

Timeline-native operations run a UI preflight that activates Final Cut Pro,
waits briefly for an accessible timeline window, and verifies timeline-pane
focus. The preflight fails closed with `FINAL_CUT_NATIVE_NO_TIMELINE_WINDOW`
when no project timeline is accessible, `FINAL_CUT_NATIVE_NOT_FRONTMOST` when
Final Cut remains background, and `FINAL_CUT_NATIVE_TIMELINE_FOCUS_REQUIRED`
when the timeline pane cannot be focused. If the Framekit extension overlay is
visible, preflight minimizes it through Accessibility with `AXMinimize`, raises
Final Cut's timeline window, and re-checks the focused window after every focus
attempt. If it cannot be minimized or remains focused, the operation fails
closed with `FINAL_CUT_NATIVE_OVERLAY_BLOCKED`. `editor.native.inspect` and
`editor.native.focus` include `timelineWindowAvailable`, `timelineFocused`,
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
