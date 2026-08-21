# Capabilities and Errors

Capabilities are machine-readable and backend-specific. A live-only Workflow
Extension reports:

```json
{
  "editor": {
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

When `FRAMEKIT_FCPXML_PATH` is configured, the composed Final Cut session also
reports `timelineSnapshotRead`, `timelineArtifactWrite`, `readAfterWrite`, and
`rollback` as true. `timelineWrite` remains false because edits update the
managed FCPXML artifact rather than the open Final Cut timeline. Analyzer flags
are true only for configured local analyzer commands, and `assetDiscovery` is
true when the Motion-template registry is available.

Important error codes include:

- `CAPABILITY_UNAVAILABLE`: the backend cannot safely perform the operation.
- `FINAL_CUT_LIVE_UNAVAILABLE`: the live socket cannot be reached.
- `FINAL_CUT_LIVE_TIMEOUT`: the bridge did not respond in time.
- `FINAL_CUT_LIVE_PROTOCOL`: framing, JSON, or version failure.
- `EDITOR_NOT_CONNECTED`: no usable editor backend is connected.
- `STALE_CONTEXT`: an edit used an old revision.
- `ANALYZER_MEDIA_UNAVAILABLE`: the configured analyzer cannot read the media source.
- `ANALYZER_TIMEOUT`: a configured analyzer exceeded its time limit.
- `ANALYZER_FAILED`: a configured analyzer exited unsuccessfully.
- `ANALYZER_INVALID_OUTPUT`: a configured analyzer returned invalid typed JSON.

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
    "requiresAccessibility": true,
    "requiresFinalCutFrontmost": true
  }
}
```

They are disabled unless `FRAMEKIT_FINAL_CUT_NATIVE_WRITES=1`. Native edits
operate on the active Final Cut selection/playhead and do not claim a complete
timeline snapshot or canonical diff.

Native errors include `FINAL_CUT_NATIVE_PERMISSION_REQUIRED`,
`FINAL_CUT_NATIVE_NOT_FRONTMOST`, `FINAL_CUT_NATIVE_SELECTION_REQUIRED`,
`FINAL_CUT_NATIVE_MODAL_BLOCKED`, `FINAL_CUT_NATIVE_COMMAND_UNAVAILABLE`,
`FINAL_CUT_NATIVE_VERIFICATION_FAILED`, and
`FINAL_CUT_NATIVE_UNDO_UNAVAILABLE`.
