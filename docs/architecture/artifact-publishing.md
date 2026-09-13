# Artifact Publishing and Non-UI Handoff

Status: decision recorded 2026-09-13

## Decision

The inspected Final Cut Pro 10.7.1 installation has no supported non-UI
project-publishing contract that provides target-bound created-project and
sequence readback. Apple documents sending an FCPXML file with the `Open`
`Document` Apple Event, but that interchange path can activate Final Cut or
require library interaction and does not provide a native transaction,
created-target identity, read-after-write, or Undo guarantee.

The Workflow Extension host exposes limited metadata for the active timeline,
not project creation or import verification. Direct `.fcpbundle` mutation is
unsupported and remains out of scope. Framekit therefore reports artifact
publishing as `headed-only` when the guarded publisher is enabled and
`unavailable` otherwise. No background project-creation capability is
advertised.

Evidence for this decision is recorded in
[`non-ui-timeline-snapshot-investigation.md`](./non-ui-timeline-snapshot-investigation.md)
and [`native-write-undo-investigation.md`](../final-cut/native-write-undo-investigation.md).
The primary Apple references are the [FCPXML Reference](https://developer.apple.com/documentation/professional-video-applications/fcpxml-reference),
[Sending Data Programmatically to Final Cut Pro](https://developer.apple.com/documentation/professional-video-applications/sending-data-programmatically-to-final-cut-pro),
and [Interacting with the Final Cut Pro Timeline](https://developer.apple.com/documentation/professional-video-applications/interacting-with-the-final-cut-pro-timeline).

## Publish contract

Every publish job is bound to:

- the exact managed FCPXML `artifactPath`;
- the verified source `transactionId`; and
- the source `artifactDigest`, which is checked again immediately before any
  headed import attempt; and
- an exact project/sequence target-binding proof from a native publisher.

Preparation is non-mutating and never opens Final Cut. Execution requires
explicit `confirm: true`. A job enters `verified` only when that stable
target-binding proof and live readback agree on the exact project and sequence
IDs. The current Workflow Extension does not provide this proof, so execution
fails with `FINAL_CUT_PUBLISH_TARGET_BINDING_UNAVAILABLE` before import and
reports that no import was attempted. `sourceTarget` and `createdTarget` remain
separate objects in the result.

## Job state machine

| State | Meaning | Next action |
| --- | --- | --- |
| `awaiting-confirmation` | The artifact and digest are valid; no editor action occurred. | Confirm the job. |
| `awaiting-final-cut` | Headed publishing or live verification is unavailable before import. | Retry when Final Cut and its provider are ready. |
| `verification-pending` | Import may have started, but created-target readback is not complete. | Retry verification only; never import again. |
| `verified` | Created project and sequence identity were observed through the live provider. | None. |
| `failed` | Source validation, target binding, or another non-retryable safety condition failed. | None. |

`awaiting-final-cut` and `verification-pending` are bounded, process-local
handoff states. They are resumable while the MCP server retains the job. The
publisher does not claim success for either state and does not expose a
created target until verification succeeds.

## MCP tools

- `artifact.publish.preview` validates the verified artifact transaction and
  returns a headed-only job without opening Final Cut.
- `artifact.publish.execute` accepts a job ID and literal `confirm: true`.
  It returns `verified`, `awaiting-final-cut`, `verification-pending`, or a
  fail-closed `failed` state when target-binding proof is unavailable.
- `artifact.publish.status` reads a job without retrying it or opening Final
  Cut.

The existing `artifact.publish` tool remains an explicit compatibility path for
the headed publisher. Its confirmation, artifact target, digest, frontmost UI,
and live readback guards remain unchanged. The headed publisher E2E is still
the opt-in proof for actual Final Cut project creation; deterministic job tests
prove only the state-machine and safety contract.

## Safety boundaries

The job flow never silently replaces the active project. If the live provider
or target-binding proof is unavailable before import, the executor is not
called. If the provider is lost after import begins, the job remains unverified
and a retry performs only bounded live verification against the saved target
binding and pre-import target. A source digest change, target mismatch, invalid
artifact, or missing confirmation fails closed.
