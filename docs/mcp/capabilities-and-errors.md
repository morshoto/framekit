# Capabilities and Errors

Capabilities are machine-readable and backend-specific. The live Workflow
Extension currently reports:

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

Important error codes include:

- `CAPABILITY_UNAVAILABLE`: the backend cannot safely perform the operation.
- `FINAL_CUT_LIVE_UNAVAILABLE`: the live socket cannot be reached.
- `FINAL_CUT_LIVE_TIMEOUT`: the bridge did not respond in time.
- `FINAL_CUT_LIVE_PROTOCOL`: framing, JSON, or version failure.
- `EDITOR_NOT_CONNECTED`: no usable editor backend is connected.
- `STALE_CONTEXT`: an edit used an old revision.

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
