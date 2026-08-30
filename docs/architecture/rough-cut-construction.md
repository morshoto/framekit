# Rough-Cut Project Construction

Issue #89 adds a media-first construction workflow while keeping project
construction separate from publishing a new editor project. The runtime owns
the plan, capability checks, transaction lifecycle, canonical observation, and
verification. An adapter owns the actual editor or artifact mutation.

## Lifecycle

1. Inspect the active project and capture its `baseRevision`.
2. Call `rough-cut.construction.plan` with ordered shots and optional video imports. This is
   read-only and emits deterministic `media.import` and primary-storyline
   `timeline.media.add` operations.
3. Call `rough-cut.construction.preview` to validate capabilities, simulate the ordered
   operations, and return a short-lived preview token plus expected diff. The
   project and revision remain unchanged.
4. Call `timeline.edit.execute` with the token. The adapter applies the whole
   workflow atomically when it advertises the required guarantees.
5. Use `edit.diff`, `edit.verify`, and the returned before/after snapshots to
   inspect the result. Use `edit.undo` to restore the original timeline and
   media registry.

Execution requires snapshot read, read-after-write, rollback, composite
transactions, and a timeline write or artifact-write capability. A missing
requirement returns `CAPABILITY_UNAVAILABLE` before adapter preview or
mutation.

## Construction primitives

| Operation | Observable behavior | Required capability |
| --- | --- | --- |
| `media.import` | Registers stable source metadata and digest | `mediaImport` |
| `timeline.media.add` | Adds a video, music, or audio occurrence by stable media ID | `mediaPlacement` |
| `timeline.media.move` | Changes an occurrence's timeline start and lane | `clipMove` |
| `timeline.media.replace` | Changes an occurrence's media and optional duration | `clipReplace` |
| `timeline.media.remove` | Removes an occurrence and attached dependent elements | `clipRemoval` |
| `timeline.transition.add` | Adds a discovered transition at an explicit adjacent edit point | `transitionPlacement`, `assetDiscovery` |
| `timeline.audio.attach` | Places an audio occurrence relative to a target video clip | `audioAttachment` |
| `timeline.audio.mix` | Sets audio gain and/or fades on an audio occurrence | `audioMixing` |
| `timeline.title.add` | Adds a discovered title occurrence with text and timing | `titlePlacement`, `assetDiscovery` |

Video rough-cut shots always target the `primary` lane and are placed in the
given order. A requested shot duration must be positive and cannot exceed the
source duration. Music and attached audio use explicit non-primary lanes.
Transition placement requires two explicit clip occurrence IDs on the same
lane with no gap; an unknown or incompatible transition asset fails closed.

## Backend boundaries

The deterministic `InMemoryEditorAdapter` advertises all construction
capabilities and applies these primitives through its existing atomic preview,
execute, read-after-write, diff, verification, rollback, and undo contract.
This is fixture evidence only; it does not claim that Final Cut is available.

The FCPXML document adapter and the metadata-only live Workflow Extension do
not advertise composite construction capabilities. Requests for the new
workflow therefore fail closed rather than routing through partial artifact or
Accessibility behavior. Native Browser import and insertion remain their
separate `editor.native.*` executor contracts until a backend can provide a
canonical snapshot and atomic construction port.

## Creating and publishing projects

`rough-cut.construction.plan` and `rough-cut.construction.preview` construct a
canonical workflow for the selected target. They never silently replace the
currently open Final Cut project. A verified artifact can be published as a new project through
`timeline.publish.new-project`, which requires a verified transaction and the
configured `FinalCutProjectPublisher`. The publisher imports a temporary copy
of the FCPXML artifact, verifies the resulting project identity when live state
is available, and does not replace the active project.

This separation means a fixture can prove rough-cut construction and an
FCPXML-backed workflow can produce a verified artifact without implying that
the open Final Cut timeline was changed.
