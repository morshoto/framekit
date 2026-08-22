# Basic Final Cut Editing MVP

Status: design contract for issue #7. This document defines the smallest
end-to-end workflow that Framekit must prove. It does not claim that the
current live Workflow Extension can perform every step.

## Scope and non-goals

The MVP takes one local video, one local music file, and one title asset and
produces one verified export. The workflow has one active project, one target
timeline, one primary video storyline, and one explicit transaction at a time.

The MVP does not cover multicam, captions, transitions, color correction,
background rendering, cloud media, or unattended destructive native UI
automation. Those are follow-up contracts.

## Workflow contract

Every run starts with a capability preflight and records the base revision. A
workflow must stop with `CAPABILITY_UNAVAILABLE` when a required capability is
missing; it must not substitute fixture data, invent timeline state, or claim
that an export succeeded.

### 1. Understand the active project

Call `connection.status`, then `editor.inspect`. When the selected backend is
ready, call `project.inspect` and `context.inspect` to capture the project,
timeline, normalized media, capabilities, and base revision. `editor.live.inspect`
may supplement this with the actual Final Cut playhead and sequence, but live
state is not a canonical timeline snapshot.

The minimum deterministic editing gate is:

- `projectRead`, `timelineSnapshotRead`, `readAfterWrite`, and `rollback`;
- `timelineWrite` or `timelineArtifactWrite` for the selected write backend;
- `assetDiscovery` before selecting a title by name;
- an analyzer capability only when the requested verification policy needs it.

### 2. Import local media

The `media.import` contract accepts an explicit local file path and returns a
stable media ID, media kind, duration, source digest, and the revision at which
the media entered the project. It must reject missing, unreadable, or
unsupported files before the transaction is previewed.

The current runtime exposes `media.search` and `media.inspect` for already
normalized media; it does not yet implement `media.import`. Until that tool is
implemented, the deterministic fixture supplies the video and music media and
the gap is reported as a blocked capability rather than hidden behind a fake
import.

### 3. Make a basic edit

Use `timeline.edit` to place the selected video on the primary storyline and
trim it to the requested duration. The edit must be tied to the captured base
revision and must return a transaction ID, before/after snapshots, a
deterministic diff, and affected ranges.

The design requires a preview/execute split for any edit that changes project
content:

1. Preview validates the operation, required capabilities, base revision, and
   expected diff without mutating the project. It returns a short-lived
   preview token and the warnings an agent must show the user.
2. Execute accepts only an unexpired token, rechecks the base revision and
   capabilities, applies the operation transactionally, and performs
   read-after-write observation.
3. A changed revision, failed precondition, or unavailable capability rejects
   execution with `STALE_CONTEXT` or `CAPABILITY_UNAVAILABLE`.

The existing `timeline.edit` path is the deterministic transaction seam. The
preview token API is a required extension of this contract; it must not weaken
the existing transaction, diff, or fail-closed behavior.

The MVP also requires an explicit placement contract for the media it adds:

- `timeline.media.add` accepts a stable `mediaId`, `role` (`video` or `music`),
  start time, duration, and target lane, then returns the planned occurrence;
- `timeline.title.add` accepts a stable title `assetId`, title text, start time,
  duration, and target lane, then returns the planned title occurrence.

Both operations are required extensions of the current `timeline.edit` surface.
They must participate in the same preview/execute transaction and revision
checks. The current runtime does not implement them yet; the missing
capabilities must remain explicit until their schemas, adapters, and fixture
behavior exist.

### 4. Add music and a title

Use `media.import` for the local music file, then use `editor.assets` with
`kind: "title"` to select an installed title by returned asset ID. Apply the
music placement through `timeline.media.add` and title placement through
`timeline.title.add`, using the same preview/execute transaction rules as the
video edit. The title and music must reference stable media or asset IDs, never
an agent-invented name or path.

The fixture must include at least one known title asset and a music item. A
backend without `assetDiscovery` or the required media/edit capability must
fail before mutation.

### 5. Export the result

The `timeline.export` contract accepts a verified transaction ID and an
explicit output path or artifact destination. It returns an export manifest
containing the source project revision, transaction ID, timeline duration,
referenced media digests, output format, and output digest. Export is allowed
only after structural verification passes.

`timeline.publish.new-project` is a different existing capability: it imports a
verified FCPXML artifact as a new Final Cut project. It is not an export and
does not mean that the currently open Final Cut timeline is directly writable.
The current runtime does not yet implement `timeline.export`; that is a
tracked contract gap for the MVP implementation.

### 6. Verify the output

Call `edit.diff` and `edit.verify` for the transaction, then validate the
export manifest and output digest. The required verification tiers are:

- Structural: the expected video, music, and title changes exist; timeline
  references resolve; duration and ordering invariants hold.
- Media signal: the output is readable, has the requested audio streams, has
  no true-peak violation, and satisfies any configured loudness policy.
- Affected-range perceptual: the exported ranges render and contain the
  requested title and audio/video content. Full-video analysis is out of scope
  for this MVP.

`edit.undo` must restore the pre-edit snapshot for a completed transaction.
After undo, `project.inspect` must show the original timeline digest and no
MVP-created media or title occurrence may remain. A failed verification must
rollback before returning a failed result.

## Required MCP surface

| Tool | Contract status | MVP responsibility |
| --- | --- | --- |
| `connection.status` | Existing | Report setup and live connection state. |
| `editor.inspect` | Existing | Report backend identity and machine-readable capabilities. |
| `project.inspect` | Existing | Read the canonical project and base revision. |
| `context.inspect` | Existing | Read the agent editing context and capabilities. |
| `media.import` | Required extension | Ingest and identify a local media file. |
| `media.inspect` | Existing | Read normalized media metadata and attached analysis. |
| `timeline.media.add` | Required extension | Place an imported video or music occurrence by stable media ID. |
| `timeline.title.add` | Required extension | Place a discovered title asset with explicit text and timing. |
| `timeline.edit` | Existing | Execute supported deterministic edits and return a transaction. |
| `timeline.edit.preview` / `timeline.edit.execute` | Required extension | Provide non-mutating preview and guarded execution. |
| `editor.assets` | Existing | Select a real installed title asset. |
| `timeline.export` | Required extension | Render/export a verified result and manifest. |
| `edit.diff` | Existing | Return the deterministic transaction diff. |
| `edit.verify` | Existing | Return structural and configured media verification checks. |
| `edit.undo` | Existing | Restore the transaction's pre-edit snapshot. |

The required extensions are design targets, not present-day tools. Adding
them requires corresponding MCP schemas, runtime contracts, deterministic
fixtures, and integration tests; this document does not silently redefine an
existing tool's input or output.

## Preview, execute, verify, and Undo rules

| Phase | Must be true | Mutation allowed | Required evidence |
| --- | --- | --- | --- |
| Preview | Base revision and capabilities are valid | No | Preview token, expected diff, warnings |
| Execute | Token and revision still match | Yes | Transaction ID, after snapshot, diff |
| Verify | Output and policy checks pass | No | `VerificationReport` and export manifest |
| Undo | Transaction is known and current state is compatible | Yes | Restored snapshot and matching original digest |

Every mutation is guarded by a revision check. Preview tokens are scoped to
the operation and backend, expire, and cannot be reused after execute or undo.
Native Final Cut operations retain their separate preview/execute and native
Undo contracts; they do not gain canonical timeline guarantees from this MVP.

## Deterministic fixture validation

The fixture scenario uses sanitized, repository-owned metadata for a project
with a video clip, a music item, and a title asset. It runs the full workflow
without Final Cut or private media and asserts:

1. the same input request produces the same normalized plan and diff;
2. preview leaves the project snapshot and revision unchanged;
3. execute produces exactly the expected video, music, and title changes;
4. stale revisions and unavailable capabilities fail before mutation;
5. verification failure restores the original snapshot;
6. a passing transaction exports a manifest whose references and digest match;
7. Undo restores the original project digest and is observable afterward.

The fixture suite is the required CI gate. It must not depend on wall-clock
timing, Final Cut availability, user-specific paths, or model output.

## Optional live Final Cut validation

Live validation is a separate macOS evidence run, not a CI prerequisite. It
must record the Framekit version, Final Cut version, backend, capability
payload, project/sequence identity, revision, and each tool result.

The first live check is read-only: `connection.status`, `editor.inspect`, and
`editor.live.inspect`. A live run may proceed to native edits only when
`FRAMEKIT_FINAL_CUT_NATIVE_WRITES=1`, Accessibility is granted, Final Cut is
frontmost, and the native capability payload explicitly enables the requested
operation. A live Workflow Extension that reports metadata, playhead, and
change events but no snapshot provider cannot satisfy canonical inspect,
export, or verification requirements; it must fail closed.

Live evidence must not be used to promote a fixture-only capability. The
FCPXML-backed canonical path and the live Final Cut state remain separate, and
`FRAMEKIT_FCPXML_PATH` is required for canonical artifact operations.

## Success metrics

The MVP is ready for implementation sign-off when all of the following are
measured on the deterministic fixture:

- 100% of the golden workflow scenarios pass end to end;
- 100% of previews leave the project unchanged and 100% of executes reject a
  stale base revision;
- 100% of failed verification cases rollback to the original digest;
- 100% of successful exports have a matching manifest, referenced-media
  digest, and output digest;
- 0 writes occur after a missing capability, invalid token, or stale revision;
- 100% of Undo checks observe the original project after the restore.

Optional live validation is successful only when every requested capability is
reported by the live backend and the run's evidence is reproducible. It is
not counted as passing merely because a connection is `ready`.
