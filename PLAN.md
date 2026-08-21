# Harden Final Cut native UI preflight

## Summary

Add a shared, fail-closed native preflight that makes Final Cut active, waits for an accessible timeline
window, verifies application focus, focuses the timeline pane, and reports precise UI-state errors before any
native timeline operation.

The live bridge, canonical FCPXML capabilities, preview-token flow, revision binding, and native Undo behavior
remain unchanged.

## Implementation changes

- Add ensureTimelineReady() to FinalCutNativeAutomationAdapter.
    - Activate Final Cut explicitly.
    - Poll every 100 ms for up to 2 seconds.
    - Require an accessible Final Cut timeline window.
    - Verify the Final Cut process is frontmost.
    - Click the existing timeline region.
    - Probe AXFocusedUIElement and classify the focus target.
    - Treat timeline-like AX roles as focused; reject browser, search, text-field, modal, or unknown focus.
    - Do not open, select, or change projects automatically.

- Introduce stable errors:
    - FINAL_CUT_NATIVE_NO_TIMELINE_WINDOW
    - FINAL_CUT_NATIVE_NOT_FRONTMOST
    - FINAL_CUT_NATIVE_TIMELINE_FOCUS_REQUIRED

- Extend native inspection context with diagnostic fields:
    - timelineWindowAvailable
    - timelineFocused
    - focusTarget
    - existing frontmost and frontWindow remain compatible.

- Apply the preflight to all timeline operations:
    - native inspection
    - selection-scoped timeline edits
    - Blade preview and execute
    - delete-range preview and execute
    - trim-to-duration preview and execute
    - native Undo
    - timeline occurrence location

- Keep Browser operations on their existing Browser-specific focus path.
- Refactor command scripts so activation and timeline focus happen once at the operation boundary. Individual
keyboard/menu scripts retain frontmost guards and post-command verification but do not repeatedly perform
best-effort activation.

- Run preflight before preview and execute. Preview tokens continue to bind to the original sequence,
revision, and duration; if focus recovery changes timeline state, execution fails as stale rather than
risking an unintended edit.

## Tests and validation

Add deterministic adapter tests covering:

- Final Cut initially not frontmost, then becoming frontmost during polling.
- Final Cut process running with no accessible window.
- Final Cut window present but process remaining background.
- Timeline click landing on a Browser/search/text-field focus target.
- Timeline focus succeeding after one or more retries.
- Focus failure causing no mutation command to execute.
- Preview succeeding but execute failing closed when preflight or revision state changes.
- Representative coverage proving all timeline operation families invoke the shared preflight.

Update MCP contract tests to verify the stable error codes and diagnostic context fields.

Extend the headed Final Cut test to:

- activate Final Cut;
- wait for a timeline window;
- verify timeline focus before media/timeline actions;
- emit the exact preflight failure category when setup is incomplete.

Update native capability/error and Final Cut live-operation documentation with the new preflight behavior and
user guidance.

Required validation:

pnpm install --frozen-lockfile
pnpm run build
pnpm run test
pnpm run check:boundaries
pnpm run xcode:check
xcodebuild -project adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/FramekitFinalCutWorkflow.xcodeproj
-list

## Assumptions

- A preflight may change macOS application focus but must not change video content, project selection, or
timeline data.

- Missing projects and missing timeline windows fail with guidance; Framekit will not choose a project
automatically.

- The two-second polling window is the default timeout.
- Native writes remain opt-in through FRAMEKIT_FINAL_CUT_NATIVE_WRITES=1.
- timelineWrite and canonical FCPXML behavior are unaffected.
- MCP compatibility is preserved through stable error-code text; diagnostic fields are additive.
