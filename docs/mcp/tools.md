# MCP Tools

## Common runtime tools

| Tool | Purpose | Backend notes |
| --- | --- | --- |
| `connection.status` | Framekit Final Cut setup and connection state | Available during live setup and reconnect |
| `editor.inspect` | Editor identity and capabilities | Available when a backend is selected |
| `editing.intent.resolve` | Map one supported natural-language request to an explicit operation and affected range | Read-only; ambiguous requests return clarification and no operation; resolved destructive requests set `previewRequired` |
| `editor.native.inspect` | Active native Final Cut selection/playhead and UI focus diagnostics | Requires native writes opt-in and Accessibility permission |
| `editor.native.focus` | Activate Final Cut and focus the timeline without editing | Bounded retry; returns focus diagnostics on failure |
| `editor.native.edit` | Selection-scoped native Final Cut edit | Requires native writes opt-in and Final Cut frontmost |
| `editor.native.undo` | Final Cut native Undo for an accepted native edit | Requires native writes opt-in |
| `editor.native.media.import` | Import one local video or audio file into the active Final Cut Browser | Automatically focuses the Browser, validates the path, waits for Browser availability, and returns a stable session media handle |
| `editor.native.media.search` | Search the active Final Cut Browser | Automatically focuses the Browser and returns short-lived media handles; native writes required |
| `editor.native.media.select` | Select a Browser result by handle | Fails if the result or selection cannot be verified |
| `editor.native.media.append.preview` | Preview appending selected Browser media to the timeline | Requires selected media, live duration, and timeline focus |
| `editor.native.media.append.execute` | Append a previously previewed Browser media result | Requires unchanged sequence revision/duration; verifies duration and revision |
| `editor.native.media.append.selected.preview` | Preview appending the currently selected Browser media to the timeline | Requires one selected Browser item with a stable AXIdentifier, live duration, and timeline focus |
| `editor.native.media.append.selected.execute` | Append the previously previewed currently selected Browser media | Revalidates the selected AXIdentifier, then verifies duration and revision |
| `editor.native.media.insert.preview` | Preview inserting selected Browser media at the playhead | Requires selected media, live playhead, and timeline focus |
| `editor.native.media.insert.execute` | Insert a previously previewed Browser media result at the playhead | Requires unchanged sequence revision/duration/playhead; verifies duration and revision |
| `editor.native.timeline.locate` | Locate timeline occurrences for a Browser result | Requires exactly one match and timeline focus before automatic editing |
| `editor.native.media.target` | Search Browser media and target one timeline occurrence | Fails closed for missing/ambiguous media or occurrences; requires live playhead state |
| `editor.native.blade.preview` | Prepare a Blade-at-playhead preview token | Token expires and is bound to the occurrence |
| `editor.native.blade.execute` | Execute a previewed Blade-at-playhead operation | Requires frontmost, timeline-focused Final Cut and post-command verification |
| `editor.native.delete-range.preview` | Preview a primary-storyline ripple delete for a rational time range | Destructive; requires explicit execute and timeline focus |
| `editor.native.delete-range.execute` | Execute a previewed primary-storyline ripple delete | Requires unchanged sequence revision and duration |
| `editor.native.trim-to-duration.preview` | Preview removal of the sequence tail after a requested duration | Preserves the beginning; destructive; requires explicit execute and timeline focus |
| `editor.native.trim-to-duration.execute` | Execute a previewed trim-to-duration operation | Requires unchanged sequence revision and duration |
| `context.inspect` | Queryable agent editing context | Backend-dependent |
| `context.changes` | Incremental timeline, live-state, and asset changes | Backend-dependent; fails closed when unavailable |
| `project.inspect` | Canonical project snapshot | Fixture/FCPXML-backed session or a canonical-capable live Final Cut bridge |
| `project.list` | Stable project and sequence catalog plus active IDs | Deterministic fixture, FCPXML-backed session, or a canonical-capable live bridge |
| `project.select` | Select a project and explicit sequence when needed | Deterministic fixture, FCPXML-backed session, or a canonical-capable live bridge; ambiguous targets fail closed |
| `timeline.inspect` | Canonical timeline snapshot | Fixture/FCPXML-backed session or a canonical-capable live Final Cut bridge |
| `timeline.frame.capture` | Image at an exact rational timeline position, with timecode and timeline metadata; optional visual analysis | Deterministic fixture; other backends fail with `CAPABILITY_UNAVAILABLE` until a capture provider is configured |
| `timeline.changes` | Canonical timeline diff | Fixture/FCPXML-backed session or a canonical-capable live Final Cut bridge |
| `timeline.edit` | Supported Phase 0 edits | Fixture/FCPXML artifact path or a canonical-capable live Final Cut bridge |
| `music.add` | Preview a searched or imported music bed with placement, gain, and fades | Deterministic fixture; execute the returned token with `music.add.execute` |
| `music.add.preview` | Explicit alias for the non-mutating music preview | Deterministic fixture |
| `music.add.execute` | Execute a music preview and return the verified transaction | Deterministic fixture; undo with `edit.undo` |
| `timeline.edit.preview` | Validate an ordered Basic Editing MVP workflow and return a short-lived token plus expected diff | Deterministic fixture; non-mutating and capability-gated |
| `timeline.edit.execute` | Execute one composite preview exactly once, verify it, and return the transaction | Deterministic fixture; stale, expired, reused, or unsupported previews fail before mutation |
| `timeline.publish.new-project` | Import a verified FCPXML artifact as a new project | Requires verified `transactionId`, FCPXML path, and native writes; never replaces the active project |
| `timeline.export` | Export the active Final Cut timeline to a local video file and verify completion, existence, duration, resolution, frame rate, and audio presence | Requires live Final Cut native writes, `ffprobe`, and one of the `master` or `web` presets; existing outputs require `overwrite: true` |
| `media.inspect` | Normalized media context | Fixture/FCPXML-backed Final Cut session |
| `media.search` | Search media references | Fixture/FCPXML-backed Final Cut session |
| `speech.analyze` | Speech and filler analysis | Fixture or configured local JSON provider |
| `audio.analyze` | Loudness, peak, and silence analysis | Fixture or configured local JSON provider |
| `visual.analyze` | Scenes, subjects, motion, and keyframes | Fixture or configured local JSON provider |
| `media.understand` | Combined speech, audio, and visual understanding | Configured providers required for Final Cut |
| `editor.assets` | Search native editor assets by text, kind, or vendor | Fixture or Motion-template registry |
| `edit.diff` | Transaction diff | Fixture/FCPXML transaction path or a canonical-capable live Final Cut bridge |
| `edit.verify` | Verification results | Fixture/FCPXML transaction path or a canonical-capable live Final Cut bridge |
| `edit.undo` | Restore a transaction | Fixture/FCPXML transaction path or a canonical-capable live Final Cut bridge |

## Live Final Cut tools

| Tool | Input | Result |
| --- | --- | --- |
| `editor.live.inspect` | none | Active project, sequence, playhead, range, and revision |
| `editor.live.changes` | `sequence`, optional `waitMs` | Events after the requested revision |

The bundled Workflow Extension is metadata-only, so its `editor.live.*` state is
not presented as a complete canonical timeline. A separate bridge may expose
canonical tools only after it advertises `canonical-read` or `canonical-write`
and passes the adapter’s snapshot, identity, target, and revision validation.
When `FRAMEKIT_FCPXML_PATH` is configured, canonical tools use that artifact
while `editor.live.*` continues to report the actual open Final Cut state; the
artifact provider does not inherit canonical-write capability from the live
state provider.

`project.list` and `project.select` use stable IDs supplied by the selected
backend. The current Workflow Extension exposes only the active project and
sequence metadata, not a project browser or project-selection API, so a
metadata-only live session rejects these tools with
`CAPABILITY_UNAVAILABLE`. A canonical-capable live bridge must return unique
project and sequence IDs and prove that an explicit selection became active;
ambiguous or mismatched responses fail closed. An FCPXML-backed session can
inspect and select its single managed project; selection never silently changes
the open Final Cut project. Its project and sequence nodes must both provide
non-empty `uid` attributes; otherwise project inspection and catalog operations
fail with `FCPXML_PROJECT_IDENTITY_UNAVAILABLE` or
`FCPXML_SEQUENCE_IDENTITY_UNAVAILABLE` instead of deriving IDs from mutable
names.

`media.search` remains canonical snapshot search. Live Browser import and search
use the explicit `editor.native.media.*` tools because Browser media identity and
timeline occurrence identity are different. Imported media handles are stable
for the current native session; timeline occurrence handles remain short-lived
and bound to the active sequence/playhead state.

## Music mixing workflow

`music.add` is the high-level guarded entry point for the issue-11 music
workflow. It accepts either an existing canonical `mediaId` (normally found
with `media.search`) or an inline `import` source containing a stable media ID,
source path, duration, and source digest. `placement: "append"` resolves the
start to the current timeline duration; `placement: "insert"` requires an
explicit non-negative `start`. Music always targets an explicit non-primary
numeric `targetLane`.

The preview is non-mutating and returns the same short-lived token contract as
`timeline.edit.preview`. Optional `gainDb`, `fadeIn`, and `fadeOut` values are
included in the planned workflow and checked after execution. Execute with
`music.add.execute`, inspect the returned verification and diff, and undo with
`edit.undo` using the returned transaction ID.

Dialogue ducking is not implemented by the deterministic adapter. A request
with `ducking.enabled: true` returns
`CAPABILITY_UNAVAILABLE: dialogue ducking` before preview or mutation.

The canonical `music.add` workflow currently requires a composite transaction
provider. Live Final Cut Browser search/import/append/insert and selection gain
remain the separate `editor.native.*` tools; a live-only backend must not be
treated as a canonical snapshot or composite music provider without advertising
those capabilities.

## Composite editing transactions

`timeline.edit.preview` accepts the canonical `baseRevision` and a non-empty,
ordered `operations` array. The workflow operation discriminants are
`media.import`, `timeline.media.add`, `timeline.audio.fades`, the existing edit
operation names such as `trim-clip`, and `timeline.title.add`. Video placement
targets `primary`; music and titles require explicit non-primary numeric lanes.
Preview validates the
entire sequence against a simulated snapshot and does not change the project,
media registry, or revision.

`timeline.edit.execute` accepts only the returned `previewToken`. Tokens expire
after 30 seconds by default and are consumed on the first execute attempt.
Execution rechecks capabilities and the base revision, then applies the ordered
operations through one adapter transaction. Verification failure or a partial
adapter write restores the pre-transaction timeline and media registry. The
deterministic fixture advertises this contract; FCPXML and live Final Cut
backends continue to fail closed until they implement the same atomic adapter
port.

## Explicit editing intent

`editing.intent.resolve` accepts a request string and recognizes only these
forms:

- `Cut at 30 seconds and remove the rest` → `trim_to_duration`
- `Blade at 30 seconds` → `blade_at_playhead`
- `Remove 10–15 seconds` → `delete_range`

The result includes the selected operation, the affected range,
`previewRequired: true`, and the exact `previewTool` to call. The resolver never
mutates the editor. Callers must use that operation-specific native preview tool
before an execute call; native execute tools accept only their short-lived
preview tokens. An unrecognized or ambiguous destructive request returns
`clarification_required` without an operation or preview tool.
