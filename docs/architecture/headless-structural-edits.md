# Headless structural Timeline IR edits

Structural edits are applied to the persisted Timeline IR through the project
transaction service. The transaction command remains the only mutation
boundary: callers provide the canonical project and sequence identities, the
expected revision, and a list of provider-neutral operations.

Supported operations are:

- `insert-occurrence`, with an exact occurrence payload and optional
  `placement: "append"`; append starts at the current sequence duration.
- `remove-occurrence`, which removes the stable occurrence identity and its
  story-element projections.
- `trim-occurrence`, which changes exact duration and optionally the exact
  `sourceStartTime`.
- `split-occurrence`, which keeps the original identity on the left segment
  and creates a caller-supplied stable identity for the right segment. The
  `splitOffsetTime` is relative to the occurrence start.
- `move-occurrence`, which changes exact timeline position and optionally the
  non-negative track.

Occurrence ordering is canonicalized by exact start time, track, and stable
identity after insert, split, and move operations. Resource references,
source bounds, positive durations, duplicate identities, and all other IR
invariants are validated before persistence. Invalid ranges fail the whole
transaction, leaving the prior project and revision unchanged.

The implementation does not invoke an NLE, Final Cut Pro, UI automation,
clipboard, XML import, or manual import. Rendering is a later boundary; these
operations only change Framekit-owned canonical state.
