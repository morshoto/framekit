# ADR-0005: Guarded Native Final Cut Selection Writes

- Status: Accepted
- Date: 2026-08-16

## Context

Final Cut's supported Workflow Extension and library scripting surfaces expose
live metadata and read-only inspection, but no supported clip mutation API.

## Decision

Framekit provides a separate, opt-in native write path using macOS Accessibility
automation through `System Events`. It operates only on the active Final Cut
selection or playhead and invokes visible Final Cut menu commands. Native Undo
uses Final Cut's own Undo command.

The path is enabled only with `FRAMEKIT_FINAL_CUT_NATIVE_WRITES=1`, requires
Accessibility and Automation permissions, and fails closed when Final Cut is
not frontmost, the target selection is unavailable, or verification cannot be
performed.

Native selection writes are separate from `timeline.edit`: they do not claim
canonical timeline snapshots, clip identity mapping, complete diffs, or
automatic FCPXML synchronization.
