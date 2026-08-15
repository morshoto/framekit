# Live Final Cut Protocol

Status: implemented and locally verified 2026-08-16.

The Swift Workflow Extension and TypeScript runtime communicate over a local
Unix-domain socket using newline-delimited JSON. The protocol version is `1`.

The default runtime socket is:

```text
~/Library/Containers/com.playhead.finalcut.workflow.extension/Data/p.sock
```

Override it with `PLAYHEAD_FINAL_CUT_SOCKET` when required.

## Request shape

```json
{
  "version": 1,
  "id": "request-id",
  "method": "capabilities | state | changes",
  "afterSequence": 0,
  "waitMs": 1000
}
```

`afterSequence` is used by `changes`; `waitMs` is optional and capped at 30
seconds by the MCP surface.

## Response behavior

Successful responses contain `identity`, `capabilities`, and optionally
`state` or `changes`. Failed responses contain a machine-readable error code
and message. The TypeScript transport rejects unavailable sockets, timeouts,
invalid JSON, unsupported protocol versions, and bridge errors.

Supported methods are `capabilities`, `state`, and `changes`. The socket is
local-only and is created by the sandboxed Workflow Extension, not by MCP.
