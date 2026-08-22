# Live Final Cut Protocol

Status: implemented and locally verified 2026-08-16.

The Swift Workflow Extension and TypeScript runtime communicate over a local
Unix-domain socket using newline-delimited JSON. The protocol version is `1`.

The default runtime socket is inside the Workflow Extension's app-sandbox
container:

```text
~/Library/Containers/com.framekit.finalcut.workflow.extension/Data/framekit.sock
```

Override it with `FRAMEKIT_FINAL_CUT_SOCKET` when required.

## Request shape

```json
{
  "version": 1,
  "id": "request-id",
    "method": "capabilities | state | changes | projects | select-project",
    "afterSequence": 0,
    "waitMs": 1000,
    "projectId": "stable-project-id",
    "sequenceId": "stable-sequence-id"
}
```

`afterSequence` is used by `changes`; `waitMs` is optional and capped at 30
seconds by the MCP surface.

## Response behavior

Successful responses contain `identity`, `capabilities`, and optionally
`state` or `changes`. Failed responses contain a machine-readable error code
and message. The TypeScript transport rejects unavailable sockets, timeouts,
invalid JSON, unsupported protocol versions, and bridge errors.

The TypeScript client understands `projects` and `select-project` for bridges
that advertise project catalog and selection capabilities. The checked-in
Workflow Extension currently returns `CAPABILITY_UNAVAILABLE` for those
methods because its public host API exposes only the active sequence; it does
not fabricate a project browser. The socket is local-only and is created by
the sandboxed Workflow Extension, not by MCP.
