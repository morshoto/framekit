# Selecting the Live Final Cut Backend

Connect Codex with the standard local MCP registration:

```sh
codex mcp add framekit -- framekit mcp --editor final-cut-live
```

The Framekit MCP process automatically:

- detects or launches Final Cut Pro;
- installs the per-user Workflow Extension artifact when needed;
- activates the extension;
- waits for the extension container socket at
  `~/Library/Containers/com.framekit.finalcut.workflow.extension/Data/framekit.sock`; and
- retries after Final Cut or extension restarts.

It does not quit or reopen Final Cut automatically. The explicit
`framekit connect finalcut` command is the recovery path when it has replaced
the extension and Final Cut needs to reload the bundle; that command performs
a graceful quit/reopen before activation.

The Workflow Extension connection is read-only. Check setup progress with the MCP
tool `connection.status` or:

```sh
framekit doctor finalcut --json
```

For a development checkout, use:

```sh
framekit connect finalcut --development
```

For a non-default socket:

```sh
FRAMEKIT_EDITOR=final-cut-live \
FRAMEKIT_FINAL_CUT_SOCKET=/tmp/framekit-finalcut-custom.sock \
npm run mcp
```

The live backend reads active project/sequence metadata, playhead, selected
sequence range, and incremental change events. Add `FRAMEKIT_FCPXML_PATH` to
compose canonical project/timeline reads, artifact edits, read-after-write,
diffs, verification, and undo. These edits update the FCPXML artifact rather
than the open Final Cut timeline.

To enable selection-scoped native UI edits:

```sh
FRAMEKIT_FINAL_CUT_NATIVE_WRITES=1 \
framekit mcp --editor final-cut-live
```

Grant Accessibility and Automation permission to the terminal or host running
the MCP process. Framekit activates Final Cut and focuses the timeline before
timeline-native operations. The user must open the intended project timeline
and select the target clip before calling `editor.native.edit`; Framekit does
not choose projects automatically. Native writes fail closed when permission,
window, focus, selection, or menu verification is unavailable.

## Live Browser search and Blade

With native writes enabled, use the live UI workflow in this order:

1. Call `editor.native.media.search` with a Browser query.
2. Call `editor.native.media.select` with one returned `mediaHandle`.
3. Call `editor.native.timeline.locate` with that handle.
4. Require exactly one returned timeline occurrence.
5. Call `editor.native.blade.preview` with its `occurrenceHandle`.
6. Call `editor.native.blade.execute` with the expiring `previewToken`.

Handles are bound to the current Final Cut UI state. A changed selection,
sequence, or expired preview causes a fail-closed error. Blade execution
verifies that Final Cut exposes two resulting segments after the command.

## Native range deletion and duration trimming

Native range operations use rational frame times and a preview/execute flow:

1. Call `editor.native.delete-range.preview` with `start` and `end`, or
   call `editor.native.trim-to-duration.preview` with the requested `duration`.
2. Confirm the returned range, expected resulting duration, sequence, and
   revision with the user before making a destructive edit.
3. Call the matching `.execute` tool with the short-lived `previewToken`.
4. Verify the returned live duration and use `editor.native.undo` if the user
   requests a rollback.

`delete-range` is limited to the primary storyline and ripple-deletes the
selected range. `trim-to-duration` preserves the beginning of the sequence and
deletes everything after the requested duration. A target duration that is
already at or beyond the current duration returns a verified no-op.

Before timeline-native preview or execute calls, Framekit activates Final Cut
Pro, waits up to two seconds for an accessible project timeline, and focuses
the timeline pane through Accessibility UI automation. It does not open or
select projects automatically. If setup is incomplete, it returns one of
`FINAL_CUT_NATIVE_NO_TIMELINE_WINDOW`,
`FINAL_CUT_NATIVE_NOT_FRONTMOST`, or
`FINAL_CUT_NATIVE_TIMELINE_FOCUS_REQUIRED` without issuing an edit command.

These operations do not automatically choose clips, connected media, or
unnecessary footage. They also do not change the canonical `timelineWrite`
capability.

## Full timeline publishing

When `FRAMEKIT_FCPXML_PATH` is configured, `timeline.edit` continues to modify
and verify the managed FCPXML artifact. With native writes also enabled,
call `timeline.publish.new-project` with the verified edit `transactionId` to
import that artifact as a new Final Cut project. It does not replace the active
project automatically.
