# Artifact Publishing and Non-UI Handoff

Status: decision recorded 2026-09-13

## Decision

Final Cut documents an FCPXML `import-options` entry named `library location`
for routing an import to a specific library. Framekit stages a copy of the
verified FCPXML with the requested new library path; the approved source stays
unchanged. A Workflow Extension sends the staged document through
`NSWorkspace.OpenConfiguration` with `activates=false`. This records dispatch,
not import completion: Final Cut may still activate itself or expose a modal
prompt. The bridge reports dispatch and side effects separately, while the
read-only Apple Events library catalog must confirm the exact library,
project, and sequence before success.

The Workflow Extension host exposes limited metadata for the active timeline,
not project creation or import verification. The separate Apple Events catalog
provides library, event, project, and sequence identities for target readback.
Direct `.fcpbundle` mutation is unsupported and remains out of scope.
`background-capable` describes only the document-open dispatch route; it does
not imply an import or target-bound readback.

Evidence for this decision is recorded in
[`non-ui-timeline-snapshot-investigation.md`](./non-ui-timeline-snapshot-investigation.md)
and [`native-write-undo-investigation.md`](../final-cut/native-write-undo-investigation.md).
The primary Apple references are the [FCPXML Reference](https://developer.apple.com/documentation/professional-video-applications/fcpxml-reference),
[Describing Final Cut Pro Items in FCPXML](https://developer.apple.com/documentation/professional-video-applications/describing-final-cut-pro-items-in-fcpxml),
[Sending Data Programmatically to Final Cut Pro](https://developer.apple.com/documentation/professional-video-applications/sending-data-programmatically-to-final-cut-pro),
and [Interacting with the Final Cut Pro Timeline](https://developer.apple.com/documentation/professional-video-applications/interacting-with-the-final-cut-pro-timeline).

## Publish contract

Every publish job is bound to:

- the exact FCPXML `artifactPath`, either managed by the publisher or bound to
  an approved headless rough-cut execution;
- exactly one verified artifact `transactionId` or approved
  `headlessExecutionId`; and
- the source `artifactDigest`, which is checked again immediately before any
  import attempt; and
- an explicit absolute `targetLibraryPath` ending in `.fcpbundle`, whose parent
  already exists and is writable and whose destination does not yet exist; and
- exact library, event, project, and sequence identities read back from that
  library after Final Cut processes the import; and
- an active-project identity match before and after headed `File > Export XML`
  readback, with supported timeline semantics matching the approved FCPXML; and
- SHA-256 digests of all referenced local source media captured before import
  and rechecked after native readback; for approved headless rough cuts, these
  digests must also match the source hashes stored with the approved project.

The staged import copy adds the FCPXML `import-options` value `library
location`. The approved artifact and its digest remain unchanged; the job
reports a separate digest for the staged copy. The bridge's `dispatched` result
records only that macOS accepted the document-open request. It is not import
proof. A job becomes `verified` only after the Final Cut Apple Events catalog
reports the exact library path and its unique project and sequence, that same
native target is active during canonical export, the exported timeline matches
the approved artifact, and source-media digests remain unchanged.

Preparation is non-mutating and never opens Final Cut. Execution requires
explicit `confirm: true`. A job enters `verified` only when catalog readback
returns the exact project and sequence IDs in the requested library, live state
confirms that exact target is active around the headed XML export, semantic
comparison passes, and source-media hashes match their pre-import values. The
active project before and after delivery is reported. Missing media, an
inactive or mismatched target, or different timeline semantics fail closed;
the job never silently falls back to Accessibility.
`sourceTarget`, `createdTarget`, and the structured `delivery` side-effect
record remain separate objects in the result.

## Job state machine

| State | Meaning | Next action |
| --- | --- | --- |
| `awaiting-confirmation` | The artifact and digest are valid; no editor action occurred. | Confirm the job. |
| `awaiting-final-cut` | Headed publishing, source media, or live verification is unavailable before import. | Retry when Final Cut and its provider are ready. |
| `verification-pending` | Import may have started, but native semantic readback or source-media integrity is not complete. | Retry verification only; never import again. |
| `verified` | Native target identity and timeline semantics match the approved FCPXML, and source-media hashes are unchanged. | None. |
| `failed` | Source validation, target binding, or another non-retryable safety condition failed. | None. |

`awaiting-final-cut` and `verification-pending` are bounded, process-local
handoff states. They are resumable while the MCP server retains the job. The
publisher does not claim success for either state and does not expose a
created target until verification succeeds.

## MCP tools

- `artifact.publish.preview` validates either a verified artifact transaction
  or an approved headless rough-cut execution, plus the explicit new library
  path, then returns a non-mutating job without opening Final Cut. The job
  records the exact source and destination for approval.
- `artifact.publish.execute` accepts a job ID and literal `confirm: true`.
  It returns `verified`, `awaiting-final-cut`, `verification-pending`, or a
  fail-closed `failed` state when target-binding proof is unavailable.
- `artifact.publish.status` reads a job without retrying it or opening Final
  Cut.

The existing `artifact.publish` tool remains an explicit compatibility path for
managed artifacts. Its confirmation, artifact target, digest, native semantic
readback, and source-media integrity guards remain in force with the same new
library path. The headed publisher E2E is still the opt-in proof for actual
Final Cut project creation; deterministic job tests prove only the state-machine
and safety contract.

The `timeline.publish.new-project` compatibility alias also requires literal
`confirm: true`, an explicit new library path, and passes through the same
eligible-route, verified artifact, digest, and live readback checks. Publishing
is not advertised for metadata-only connections or when the publisher cannot
read the native library catalog and live project state.

## Safety boundaries

The job flow never chooses or overwrites an existing library path. If the live
provider, target-binding reader, canonical snapshot reader, or any referenced
local source media is unavailable before import, the executor is not called. If
native semantic readback is unavailable after import begins, the job remains
unverified and a retry performs verification only against the same requested
library path. A source digest change, target mismatch, timeline mismatch,
invalid artifact, or missing confirmation fails closed.
