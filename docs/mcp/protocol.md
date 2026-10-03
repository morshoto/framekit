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

An injected background library provider is a separate read-only catalog source.
When present, `project.list` can return library projects while Final Cut is not
frontmost; the result retains catalog provenance, observed live revision and
rational timing values, and stable-ID reconciliation status. This source does
not enable `select-project` and does not upgrade metadata-only state to a
canonical timeline snapshot. An unresolved or stale result includes per-scope
diagnostics such as `stable-id-mismatch` or `ambiguous-name`, along with the
live and candidate catalog identities needed to explain the fail-closed result.
It also includes `reconciliation.blocker.code: "target-selection-required"`
and clears active IDs. When selection is unavailable, the same actionable
blocker is prefixed to `selection.unavailableReason`. These results leave
canonical read/write capabilities unavailable.

The canonical native provider does not fall back to its headed canonical
snapshot to construct `project.list`. Without a background catalog provider,
`project.list` returns a structured `CAPABILITY_UNAVAILABLE` response that
identifies canonical `File > Export XML` as the first headed requirement;
`project.inspect` remains the explicit canonical snapshot operation.

## MCP context revision cursors

The MCP `context.inspect` and `context.changes` tools use the editor revision
as a source-bound cursor. `context.inspect` returns the current revision,
project/sequence target when available, provider provenance, an evidence tier,
and an initially empty `changedScopes` list. Pass its `cursor` object to
`context.changes` to request incremental results. The legacy `sequence` input
is retained for compatibility, but it does not carry target metadata. A
source-bound cursor with a mismatching target fails closed with
`TARGET_MISMATCH` before changes are read.

Each context result identifies whether an observation came from a
`canonical-timeline`, `live-metadata`, `fcpxml-artifact`, or
`deterministic-fixture` source. A metadata-only live provider may expose
playhead or sequence changes, but it never fills the canonical timeline diff.
Artifact observations remain explicitly `fcpxml-artifact` evidence and do not
claim headed-native or canonical-live proof.
