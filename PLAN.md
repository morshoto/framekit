# Final Cut Live Editing and Timeline Publishing

## Summary

Extend Framekit from selection-scoped UI commands into a guarded hybrid workflow:

- Search Final Cut’s active Browser/library through Accessibility UI automation.
- Select a matching Browser media item and locate exactly one matching occurrence in the active timeline.
- Blade that occurrence at the playhead with preview-token confirmation.
- Support complete canonical FCPXML edits and publish the result into Final Cut as a new project.

The Workflow Extension remains metadata/playhead/change-event only. Native UI automation remains a separate
capability and must fail closed when Final Cut, selection, permissions, or identity checks are unavailable.

## Key changes

### Native media discovery and selection

Add native tools for:

- editor.native.media.search
  - Search the active Final Cut Browser/library by clip name or source path.
  - Return visible metadata plus short-lived opaque media handles.
  - Never fabricate results when the Accessibility tree cannot be inspected.

- editor.native.media.select
  - Select a Browser result using its handle.
  - Verify the expected media item remains selected.

- editor.native.timeline.locate
  - Resolve the Browser media identity to timeline occurrences in the active sequence.
  - Require exactly one match for automatic editing.
  - Return a short-lived occurrence handle containing sequence, media identity, timeline range, playhead
    revision, and UI context.

  - Return explicit ambiguity when zero or multiple occurrences match.

Browser media identity and timeline occurrence identity must remain separate.

### Blade/split editing

Add a true Blade-at-playhead operation:

- editor.native.blade.preview
  - Validate Final Cut is frontmost.
  - Validate the target occurrence handle is current.
  - Validate the playhead lies inside the target occurrence.
  - Return the intended command, target identity, before-state, and expiring preview token.

- editor.native.blade.execute
  - Require the preview token.
  - Revalidate frontmost state, sequence, occurrence, playhead, and selection.
  - Invoke Final Cut’s Blade menu/keyboard command through Accessibility automation.
  - Verify that the target changed from one occurrence to two resulting timeline segments.
  - Return both resulting occurrence descriptions and an operation ID.

- editor.native.undo
  - Continue using Final Cut’s native Undo.
  - Bind undo records to the blade operation and reject unknown or stale operation IDs.

The existing rename, trim, gain, and marker operations remain available but are clearly documented as
selection-scoped operations, not full timeline editing.

### Full timeline writes

Keep deterministic canonical edits in the FCPXML provider.

Add a publish workflow:

- Apply and verify the requested full-timeline edit against the managed FCPXML artifact.
- Validate the final FCPXML before any Final Cut UI action.
- Create a disposable publish copy.
- Use Final Cut’s visible Import XML workflow to create a new project from that copy.
- Verify the newly imported project and sequence appear in Final Cut.
- Return the new project identity and source transaction ID.
- Never replace or mutate the original active project in v1.

Add a separate capability such as timelinePublishNewProject; do not set generic timelineWrite=true, because
the operation is an import/publish workflow rather than direct in-place mutation.

### Capability and error contracts

Extend the native capability block with distinct flags:

{
"native": {
    "mediaLibrarySearch": true,
    "mediaSelection": true,
    "timelineOccurrenceLocate": true,
    "bladeAtPlayhead": true,
    "selectionEdit": true,
    "undo": true,
    "requiresAccessibility": true,
    "requiresFinalCutFrontmost": true
},
"editor": {
    "timelineWrite": false,
    "timelinePublishNewProject": true
}
}

Add fail-closed errors for:

- native search unavailable
- Browser result not found
- selection verification failed
- timeline occurrence not found
- ambiguous occurrence
- stale selection handle
- playhead outside target occurrence
- blade command unavailable
- blade verification failed
- publish validation failed
- Final Cut import verification failed

Update MCP descriptions so Codex distinguishes:

- live inspection,
- Browser discovery,
- selection-scoped native edits,
- Blade operations,
- canonical FCPXML edits,
- new-project publishing.

## Test plan

### Deterministic tests

- Search returns typed media handles.
- Duplicate Browser results are represented without collapsing identity.
- Timeline occurrence matching rejects zero and multiple matches.
- Handles become invalid after sequence, selection, or playhead revision changes.
- Blade preview refuses an out-of-range playhead.
- Blade execution requires a valid preview token.
- Blade results contain two verified segments.
- Unknown and stale undo operations fail safely.
- FCPXML publish validates the artifact before invoking native automation.

### Native headed E2E

Using a disposable duplicate Final Cut project:

1. Start Framekit with native writes enabled.
2. Confirm Accessibility permissions and frontmost Final Cut timeline.
3. Search the active Browser for a known video.
4. Select the result and verify selection identity.
5. Locate exactly one matching timeline occurrence.
6. Move or confirm the playhead inside that occurrence.
7. Preview the Blade operation.
8. Execute it.
9. Verify two resulting timeline segments.
10. Undo through Final Cut and verify the original single occurrence returns.

Additional headed cases:

- no Final Cut window,
- Final Cut not frontmost,
- no Browser result,
- ambiguous media match,
- multiple timeline occurrences,
- modal dialog open,
- denied Accessibility permission,
- playhead outside the clip,
- unsaved original project remains unchanged after FCPXML publish.

Run the existing repository validation in addition to the native E2E suite:

pnpm install --frozen-lockfile
pnpm run build
pnpm run test
pnpm run check:boundaries
pnpm run xcode:check
xcodebuild -project adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/FramekitFinalCutWorkflow.xcodeproj
-list

## Assumptions and defaults

- “Search Final Cut’s live media library” means the active Browser/library UI, not a filesystem registry and
not an invisible private database.

- Automatic Blade requires exactly one matching timeline occurrence.
- A Browser media item and a timeline occurrence are different identities.
- Native handles are short-lived and revision-bound, not permanent Final Cut IDs.
- “Full timeline writes” means verified FCPXML edits published as a new Final Cut project in v1.
- The original active project is never replaced automatically.
- Accessibility/System Events remains the native mechanism because Final Cut’s exposed scripting dictionary is
read-only for library inspection.
