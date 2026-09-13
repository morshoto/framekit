# ADR-0010: Stable Timeline Targets for Native Edits

- Status: Accepted
- Date: 2026-09-13
- Issue: [#261](https://github.com/morshoto/framekit/issues/261)

## Context

Native Final Cut operations historically addressed the selected Browser item,
selected timeline clip, current playhead, or a screen coordinate. Those values
are useful for a headed compatibility adapter, but they are not stable identity
for a requested project, sequence, or timeline occurrence. Window focus,
selection changes, and timeline edits can therefore redirect a mutation.

Framekit already has stable project, sequence, media, occurrence, and revision
identities in canonical snapshots. Native targeting must use the same identity
model and preserve exact rational timeline coordinates wherever a position or
range is part of the operation.

## Decision

The runtime owns the shared `TimelineTarget` contract. A target contains:

- `projectId` and `sequenceId` for the addressed timeline;
- `revision` captured when the target was read;
- `timelineStartTime` and `frameDuration` for the sequence frame grid;
- optional stable `mediaId`;
- optional occurrence identity with `id`, media binding, and exact rational
  `startTime` and `durationTime`; and
- optional rational `range`.

Targets are created from a canonical `ProjectSnapshot` or emitted by a native
provider with equivalent live project, sequence, revision, and occurrence
evidence. Names, array indexes, screen coordinates, playhead position, AX row
indexes, and native UI handles never become target identity.

## Resolution and mutation lifecycle

Providers follow this sequence for an operation that supports stable targeting:

1. Capture the explicit project, sequence, revision, media, occurrence, and
   rational coordinate target.
2. Resolve the target against the current snapshot or provider state.
3. Reject stale revisions, wrong project or sequence, ambiguous occurrences,
   missing identities, media drift, and non-frame-aligned coordinates before
   mutation.
4. Bind any short-lived headed handle to the validated target. The handle is an
   implementation detail and cannot replace the target.
5. Mutate through the provider's supported operation.
6. Read the same project and sequence back, then verify occurrence and media
   identity. Trim and move operations may change coordinates; they may not
   silently change identity.
7. If verification fails, rollback is allowed only when the operation remains
   bound to the same revision and native Undo can verify restoration.

Errors are structured by stable failure class: `STALE_CONTEXT` for revision
drift, `TARGET_MISMATCH` for scope or identity drift,
`AMBIGUOUS_TIMELINE_TARGET` for duplicate matches, and
`FRAME_ALIGNMENT_REQUIRED` for coordinates outside the sequence frame grid.
Providers fail closed when the evidence needed for a target is unavailable.

## Native Final Cut boundary

`editor.native.media.target` now returns a `TimelineTarget` alongside its
legacy media, occurrence handle, selection, and playhead fields. Its stable
payload is the handoff for later targeted native operations. The canonical
headed provider binds rename and read-after-write verification to a runtime
target and requires a native occurrence identity and matching sequence ID.

The existing selection- and playhead-based Accessibility operations remain an
explicit headed compatibility surface. They are not the public source of truth
for stable targeting and must continue to report their native capability and
focus requirements. A future operation may consume the stable target directly
only after its provider can resolve and read back that target without guessing.
The bundled Workflow Extension must not manufacture occurrence IDs from UI
indexes or claim background mutation when it cannot expose the required target
evidence.

## Operation coverage

The contract applies to any operation with an explicit timeline target,
including append, insert, trim, delete, move, replace, title, transition,
picture-in-picture, mask, and audio operations. Each provider advertises only
the operation paths for which it can perform target resolution, frame-aligned
mutation, read-after-write verification, and rollback. Existing deterministic
and FCPXML providers continue to use their stable snapshot IDs; native
selection compatibility does not upgrade those guarantees.

## Consequences

- Runtime code can validate target scope, revision, identity, and frame
  alignment independently of Final Cut UI details.
- Native discovery can hand an explicit target to a later operation without
  treating the playhead or selection as identity.
- Coordinate changes caused by valid trim or move operations remain possible,
  while media and occurrence identity drift is rejected.
- Background-capable implementations must supply a non-UI resolver and
  operation-level readback before advertising that capability.
- Headed-native results and canonical timeline results remain distinct evidence
  tiers; a green deterministic test does not claim live Final Cut placement.
