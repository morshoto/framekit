# Capabilities and Errors

Capabilities are machine-readable and backend-specific. The live Workflow
Extension currently reports:

```json
{
  "projectRead": true,
  "liveSelection": true,
  "livePlayhead": true,
  "incrementalChanges": true,
  "timelineRead": false,
  "timelineWrite": false,
  "readAfterWrite": false,
  "rollback": false,
  "speechAnalysis": false,
  "audioAnalysis": false,
  "visualAnalysis": false,
  "assetDiscovery": false,
  "playbackControl": false
}
```

Important error codes include:

- `CAPABILITY_UNAVAILABLE`: the backend cannot safely perform the operation.
- `FINAL_CUT_LIVE_UNAVAILABLE`: the live socket cannot be reached.
- `FINAL_CUT_LIVE_TIMEOUT`: the bridge did not respond in time.
- `FINAL_CUT_LIVE_PROTOCOL`: framing, JSON, or version failure.
- `EDITOR_NOT_CONNECTED`: no usable editor backend is connected.
- `STALE_CONTEXT`: an edit used an old revision.

The runtime must not fabricate empty timelines, pretend a write succeeded, or
fall back to fixture data without reporting that decision.
