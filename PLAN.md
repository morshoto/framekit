# Native Final Cut timeline operations

## Summary

Add three guarded live Final Cut operations:

- blade_at_playhead: split the explicitly targeted timeline occurrence at the current playhead.
- delete_range: ripple-delete an explicit time range from the primary storyline.
- trim_to_duration: preserve the beginning of the sequence and ripple-delete everything after the requested
duration.

All destructive operations use preview tokens, explicit execute calls, revision binding, native Undo, and
post-operation verification. These remain separate native UI capabilities; timelineWrite and canonical live
timeline snapshots remain unavailable.

## API and capability changes

- Preserve the existing editor.native.blade.preview / editor.native.blade.execute contract and document it as
blade_at_playhead.

- Add:
  - editor.native.delete-range.preview
  - editor.native.delete-range.execute
  - editor.native.trim-to-duration.preview
  - editor.native.trim-to-duration.execute

- Use rational frame times:
  - delete-range.preview: { start: { value, timescale }, end: { value, timescale } }
  - trim-to-duration.preview: { duration: { value, timescale } }

- Add native capability flags for deleteRange and trimToDuration.
- Return preview metadata containing project, sequence, revision, requested range/duration, expected resulting
duration, expiration, and token.

- Return execute results containing operation ID, before/after live state, duration verification, and
undoAvailable.

- Reuse editor.native.undo for all three operations.

## Native behavior

### blade_at_playhead

- Require Final Cut frontmost, native writes enabled, one uniquely identified timeline occurrence, and Blade
enabled.

- Keep the current occurrence-handle workflow:
    1. Search/select media.
    2. Locate exactly one timeline occurrence.
    3. Preview Blade.
    4. Execute Blade.

- Verify two resulting segments.
- Blade alone does not change sequence duration.

### delete_range

- Support only the primary storyline in v1.
- Always use ripple-delete semantics; later content shifts earlier.
- Validate:
  - start < end
  - range is inside the active sequence
  - active project, sequence, and revision remain unchanged
  - Final Cut is frontmost and timeline-focused

- Use native UI automation to position the range precisely in Final Cut, select it, and invoke the visible
Delete/Ripple Delete command.

- Fail closed if the range cannot be positioned or selected with frame-accurate verification.
- Verify the sequence duration decreases by the requested range duration within one frame of tolerance.

### trim_to_duration

- Preserve the beginning of the sequence.
- If the requested duration is shorter than the current duration, internally delete [targetDuration,
currentSequenceEnd] using ripple-delete semantics.

- If the target equals or exceeds the current duration, return a verified no-op without mutating Final Cut.
- Verify the resulting sequence duration is no greater than the requested duration and does not remove content
before the target boundary.

- Expose this as a distinct operation so Codex can distinguish “make it 30 seconds” from arbitrary range
deletion.

## Safety and UX

- Preview tokens expire after the existing short native-operation window.
- Tokens bind to project, sequence, revision, requested range/duration, and target scope.
- Execute rejects stale playhead, sequence, revision, focus, selection, or changed duration state.
- MCP descriptions must explicitly distinguish:
  - Blade = split only.
  - Delete range = remove a specified range.
  - Trim to duration = preserve the beginning and remove the remainder.

- Codex should ask for intent when a request such as “make a cut” does not specify one of these operations.
- Do not automatically choose clips or infer “unnecessary footage” in this phase.
- Do not enable canonical timelineWrite; these operations remain guarded Accessibility-based native UI edits.

## Testing and acceptance

- Add deterministic adapter tests for:
  - rational range validation;
  - target duration validation and no-op behavior;
  - preview expiration;
  - stale revision/sequence rejection;
  - delete and trim script generation;
  - expected duration verification;
  - native Undo registration;
  - live connection suspension during the entire UI transaction.

- Add MCP contract tests for all preview/execute tools, schemas, capability flags, and structured errors.
- Extend headed Final Cut E2E coverage with a disposable project:
  - Blade at playhead → two segments → Undo restores one segment.
  - Delete a known range → duration decreases by the expected amount → Undo restores the original duration.
  - Trim to a target duration → final duration is within one frame of target → Undo restores the original
    duration.

- Run the required repository checks:
  - pnpm install --frozen-lockfile
  - pnpm run build
  - pnpm run test
  - pnpm run check:boundaries
  - pnpm run xcode:check
  - xcodebuild ... -list

- Update native MCP, Final Cut, capability/error, and headed E2E documentation.

## Assumptions

- “Delete” means ripple-delete.
- The supported scope is the primary storyline only.
- trim_to_duration keeps the beginning of the sequence.
- Times are exact rational frame times.
- All three operations target live Final Cut native automation only.
- Automatic clip selection, content analysis, and agent-selected removal are deferred.
