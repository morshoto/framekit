# ADR-0007: Guarded Native Range and Duration Writes

- Status: Accepted
- Date: 2026-08-21

## Context

The live Final Cut Workflow Extension exposes sequence metadata and playhead
state but not canonical timeline writes. Accessibility automation can use
visible Final Cut commands, provided the target range and resulting state can
be verified.

## Decision

Framekit exposes three native live operations:

1. Blade a uniquely identified timeline occurrence at the current playhead.
2. Ripple-delete an explicit rational range from the primary storyline.
3. Preserve the beginning of the sequence and ripple-delete its tail after a
   requested duration.

Range and duration writes require expiring preview tokens, unchanged sequence
revision and duration, Final Cut focus, native writes opt-in, and post-write
live-duration verification. Each accepted mutation is registered for Final
Cut-native Undo.

## Consequences

- Native range operations are separate from canonical `timeline.edit`.
- `timelineWrite` remains false for the live Workflow Extension backend.
- Connected-clip selection, automatic clip choice, and unnecessary-footage
  analysis remain future capabilities.
- A verified no-op is returned when `trim-to-duration` is already satisfied.
