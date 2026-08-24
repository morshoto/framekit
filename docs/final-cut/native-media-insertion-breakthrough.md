# Native Final Cut Media Insertion: Breakthrough Notes

Status: verified locally on 2026-08-25 with Final Cut Pro and the live
Workflow Extension. The implementation is in commit `b041a35` and its two
preceding Browser-automation commits.

## What finally worked

The operation is a guarded native workflow, not a canonical timeline write:

```text
connection.status
  -> editor.native.inspect
  -> editor.live.inspect
  -> editor.native.media.search
  -> editor.native.media.select
  -> editor.native.media.append.preview
  -> editor.native.media.append.execute
  -> editor.live.inspect
```

The verified run found and selected `Blue Steel Guitar`. The live timeline
changed from duration `0/1`, revision `rev-6` to duration `100100/24000`,
revision `rev-8`. The operation was performed without a user click.

## The decisive findings

### Browser Accessibility is not a media database

Final Cut exposed the visible Browser result as an `AXGroup` whose display
name was in `AXDescription`; the group and its `AXImage` child had no
`AXIdentifier`. The adapter therefore had to:

- read `value`, then `name`, then `description` while treating `missing value`
  as empty;
- recognize the `Events` container and generic media roles;
- traverse children with bounded, indexed paths;
- derive a session-scoped source identity from the Accessibility path, role,
  and name; and
- refuse ambiguous or identity-less matches.

Never manufacture a media handle from a name or screen coordinates alone.
The path-based identity is only an Accessibility-session targeting identity,
not a canonical Final Cut media ID.

### Search has two UI states

The Browser may expose an open `AXTextField` or only its magnifying-glass
button. The adapter first reuses a focused search field, then uses bounded
layout fallbacks, and only then performs the deeper Accessibility search.
This ordering matters: sorting or walking the entire Final Cut tree can
consume the native automation deadline even when the search control is
visible.

### Selecting media changes keyboard focus

Pressing the `AXGroup` itself can open Final Cut's rename sheet. Selecting the
contained thumbnail avoids that side effect. After selection, Final Cut keeps
focus in the Browser search field. A System Events `click at` is insufficient
to move focus to the timeline; a native CoreGraphics mouse click on the
timeline is required before sending Final Cut's `E` (append) or `W` (insert)
shortcut.

### The first append can open a Final Cut modal

Appending the first clip to an empty project can show Final Cut's “video
properties are not recognized” properties sheet. If the sheet is left open,
the native command has already reached Final Cut but live verification remains
at zero and reports a misleading insertion failure. The insertion script now
accepts only the sheet's `OK` button, then waits for the normal read-after-write
check. It never sends an unconditional Return to the timeline.

## Instructions for future agents

1. Use the current MCP deployment. Rebuild the package and restart the MCP
   process if the tool catalog or behavior appears stale; a `ready` socket is
   not proof that the process is running the current checkout.
2. Check `editor.native.inspect` before every native operation. Require
   `frontmost`, `timelineWindowAvailable`, `timelineFocused`, and a non-modal
   focus target. Treat `AXSheet`, `AXDialog`, `FINAL_CUT_NATIVE_NOT_FRONTMOST`,
   and `FINAL_CUT_NATIVE_OVERLAY_BLOCKED` as actionable blockers.
3. Keep search, selection, preview, and execute in one MCP session so the
   short-lived media handle and preview token remain valid.
4. Use the returned media handle; do not infer a handle from a screenshot or
   clip name. The selected Browser item must be revalidated immediately before
   insertion.
5. Claim success only after `editor.live.inspect` proves both a duration
   increase and a new revision. If either is unchanged, stop and inspect the
   UI state rather than retrying blindly or asking the user to click.
6. Keep the active project disposable during headed validation. Native media
   insertion is separate from canonical FCPXML editing and should not be
   described as a canonical timeline snapshot or diff.

## Validation record

The implementation was validated with:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run test
pnpm run check:boundaries
pnpm run xcode:check
xcodebuild -project adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/FramekitFinalCutWorkflow.xcodeproj -list
```

The full test suite passed 179 tests. The focused native suite passed 60
tests. No private media, credentials, crash dumps, or user-specific paths are
part of this document.
