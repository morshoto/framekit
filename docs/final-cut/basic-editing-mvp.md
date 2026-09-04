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

For the complete MVP workflow, the backend must also advertise or expose
`media.import`, `timeline.media.add`, `timeline.title.add`,
`editor.timeline.edit.preview`, `editor.timeline.edit.execute`, and
`timeline.export`. A
missing workflow capability is detected before any project mutation; tool
presence must not be inferred from a documentation-only contract.

### 2. Import local media

The `media.import` contract accepts an explicit local file path and returns a
stable media ID, media kind, duration, source digest, and the revision at which
the media entered the project. It must reject missing, unreadable, or
unsupported files before the transaction is previewed.

The composite runtime accepts `media.import` as a workflow operation and the
deterministic fixture registers its normalized media metadata atomically with
the timeline changes. It is not a standalone canonical import tool and does not
claim live Final Cut ingestion. Live Browser import remains the separate
`editor.native.media.import` capability.

Import preview stages the source digest without changing the project revision.
Import execute is atomic: a successful import advances the revision exactly
once, while a missing or unreadable source leaves both the media registry and
revision unchanged. The workflow transaction owns the imported media, so
`edit.undo` must restore the pre-workflow media registry as well as the
timeline. An adapter that cannot provide this compensating rollback must report
the capability as unavailable before execution.

### 3. Make a basic edit

Use `timeline.media.add` with `role: "video"` to place the selected video on
the primary storyline, then use `editor.timeline.edit` to trim it to the requested
duration. The edit must be tied to the captured base revision and must return a
transaction ID, before/after snapshots, a deterministic diff, and affected
ranges. The current `editor.timeline.edit` implementation supports rename, trim, gain,
ripple-delete, and marker operations; placement is a required extension.

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

The target-specific `editor.timeline.edit` path is the deterministic live
transaction seam. The target-specific `artifact.edit` path is the equivalent
FCPXML transaction seam. Neither path may weaken the existing transaction, diff,
or fail-closed behavior.

Verification intent is carried in `verification.assertions` on direct edits,
composite previews, and music operations. Each assertion produces a
machine-readable check with `expected`, `observed`, and a failure `reason`.
Supported intent includes audio audibility, audio coverage, loudness, source
identity, visual content, duration, stream presence, and structural presence.
An audio stream is not evidence that audio is audible: an audibility analyzer
must report audible samples or bounded silence. A source identity assertion may
also require the expected source digest so a valid but wrong file cannot pass.
When a requested analyzer is missing, the check reports `status: "unavailable"`
and the transaction fails closed; it is never treated as a pass.

The MVP also requires an explicit placement contract for the media it adds:

- `timeline.media.add` accepts a stable `mediaId`, `role` (`video` or `music`),
  start time, duration, and `targetLane`, then returns the planned occurrence.
  For `role: "video"`, `targetLane` is implicitly `"primary"` when omitted and
  any non-primary lane is rejected. Music requires an explicit non-primary
  audio lane;
- `timeline.title.add` accepts a stable title `assetId`, title text, start time,
  duration, and `targetLane`, then returns the planned title occurrence.

Both operations participate in the same preview/execute transaction and
revision checks. Their workflow schemas and deterministic fixture behavior are
implemented. Other adapters must continue to report the capabilities as
unavailable until they provide atomic preview, execution, and rollback.

### 4. Add music and a title

Use `media.import` for the local music file, then use `editor.assets` with
`kind: "title"` to select an installed title by returned asset ID. Apply the
music placement through `timeline.media.add` with `role: "music"` and title
placement through `timeline.title.add`, using the same preview/execute
transaction rules as the video edit. The title and music must reference stable
media or asset IDs, never an agent-invented name or path.

The fixture must include at least one known title asset and a music item. A
backend without `assetDiscovery` or the required media/edit capability must
fail before mutation.

### 5. Export the result

The `timeline.export` contract accepts a verified transaction ID and an
explicit output path or artifact destination. It returns an export manifest
containing the source project revision, transaction ID, timeline duration,
referenced media digests, output format, and output digest. Export is allowed
only after structural verification passes.

`artifact.publish` is a different capability: it imports a verified FCPXML
artifact as a new Final Cut project after receiving the matching `artifactPath`
and explicit `confirm: true`. It is not an export and does not mean that the
currently open Final Cut timeline is directly writable.
The current live MCP implementation exposes `timeline.export` with explicit
`outputPath` and `preset` values, and verifies the rendered file with `ffprobe`.
When `transactionId` is supplied, the MCP export path requires that the
transaction is verified and still targets the active project and sequence. It
returns the transaction-bound manifest described above, including the output
format and a `sha256:` digest of the verified output. Calls without a
transaction ID remain available for standalone native timeline export but are
not sufficient evidence for this deterministic MVP gate.

Semantic export assertions are supplied under `expected.assertions`. A
configured semantic export analyzer may provide audio analysis, visual labels,
and source identity alongside the mechanical probe. The export verification
report preserves expected versus observed values for every assertion. If the
semantic analyzer is unavailable or an assertion fails, export reports a
machine-readable failure and replaces no existing output; the staging file is
removed. The default `ffprobe` path remains mechanical-only and must not claim
semantic success without configured evidence.

### 6. Verify the output

Call `edit.diff` and `edit.verify` for the transaction, then validate the
export manifest and output digest. The required verification tiers are:

- Structural: the expected video, music, and title changes exist; timeline
  references resolve; duration and ordering invariants hold.
- Media signal: the output is readable, has the requested audio streams, has
  no true-peak violation, and satisfies any configured loudness policy.
- Affected-range semantic: configured assertions prove audio audibility,
  coverage, loudness, source identity, and requested visual content. Full-video
  perceptual analysis without a configured analyzer is out of scope for this
  MVP and must be reported as unavailable.

`edit.undo` must restore the pre-edit snapshot for a completed transaction.
The transaction is scoped to its original project and sequence; if another
target is active, undo fails with `TARGET_MISMATCH` before requesting a restore.
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
| `media.import` | Composite operation | Register normalized media metadata inside the ordered fixture workflow; live import remains editor-specific. |
| `media.inspect` | Existing | Read normalized media metadata and attached analysis. |
| `timeline.media.add` | Composite operation | Place an imported video or music occurrence by stable media ID and role-specific lane. |
| `timeline.title.add` | Composite operation | Place a discovered title asset with explicit text and timing. |
| `artifact.edit` | Existing | Edit the managed FCPXML artifact with an explicit artifact target. |
| `editor.timeline.edit` | Existing | Edit the explicitly identified live project and sequence. |
| `editor.timeline.edit.preview` / `editor.timeline.edit.execute` | Implemented for deterministic fixture | Provide non-mutating preview and guarded, single-use execution for the live target. |
| `artifact.publish` | Existing | Create/import a new project from a verified artifact with explicit confirmation. |
| `editor.assets` | Existing | Select a real installed title asset. |
| `timeline.export` | Required extension | Render/export a verified result and manifest. |
| `edit.diff` | Existing | Return the deterministic transaction diff. |
| `edit.verify` | Existing | Return structural and configured media verification checks. |
| `edit.undo` | Existing | Restore the transaction's pre-edit snapshot. |

These target-specific tools require corresponding MCP schemas, runtime
contracts, deterministic fixtures, and integration tests. They do not silently
redefine an existing tool's input or output.

The complete MVP uses one composite workflow transaction for video placement,
trim, music placement, and title placement. Its preview returns one token and
expected diff; execute returns one transaction ID, before/after snapshots,
complete diff, affected ranges, and verification record. All operations commit
together or rollback together. This orchestration is implemented by the
deterministic fixture while adapters that do not advertise the composite
capabilities fail closed. Undo restores the original timeline and media
registry in one observable operation. Export manifests remain tracked by the
separate export work.

The composite MCP entry point is `editor.timeline.edit.preview` followed by
`editor.timeline.edit.execute`. Preview accepts an explicit project ID, sequence
ID, base revision, and an ordered operation list named `operations`, containing
the video `timeline.media.add`, `trim-clip`, music `timeline.media.add`, and
`timeline.title.add` operations. Each operation keeps
its stable IDs, role-specific `targetLane`, timing, and operation-specific
arguments. Execute accepts only `{ previewToken }`; it returns the single
transaction ID, before/after snapshots, complete diff, affected ranges, and
verification record for the all-or-nothing workflow.

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
