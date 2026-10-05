# Headless Timeline IR property edits

The property subset required by the v0.1.15 headless workflow is represented
on each canonical occurrence and is edited through the same project
transaction contract as structural operations.

Supported properties are:

- `set-gain`, with a finite decibel value.
- `set-transform`, with positive `scaleX` and `scaleY` plus optional finite
  position and rotation values.

The transform is provider-neutral. A renderer may interpret the transform for
its output surface, while the canonical project stores the intent without an
NLE-specific effect identifier. Project persistence serializes the occurrence
properties with the rest of the Timeline IR, so preview remains non-mutating
and execute advances exactly one guarded revision.

Unknown operation types are rejected as `PROJECT_EDIT_UNSUPPORTED`; malformed
supported properties are rejected as `PROJECT_EDIT_INVALID`. Neither case
silently drops a requested property or invokes an NLE.
