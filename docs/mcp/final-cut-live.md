# Selecting the Live Final Cut Backend

For end users, configure the Framekit marketplace once:

```sh
codex plugin marketplace add morshoto/framekit
```

Open `/plugins`, install **Framekit**, and start a new Codex session. The plugin
registers `npx -y @morshoto/framekit mcp --editor final-cut-live --headless`; a repository
checkout and manual `codex mcp add` are not required.

In normal (non-headless) mode, the Framekit MCP process automatically:

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

The registration above uses headless mode, so it skips that lifecycle recovery
and only probes the existing socket.

The bundled Workflow Extension connection is metadata-only. Check setup progress with the MCP
tool `connection.status` or:

```sh
framekit doctor finalcut --json
```

## Headless mode

For repository development without the plugin, start the equivalent headless
live server with:

```sh
framekit mcp --editor final-cut-live --headless
```

Headless mode only probes the existing Workflow Extension socket. It does not
launch or activate Final Cut, minimize or raise windows, request Accessibility
focus, or enable native UI writes. If the socket is not already available,
`connection.status` reports `FINAL_CUT_HEADLESS_SOCKET_UNAVAILABLE` rather than
trying to recover by opening Final Cut.

This mode can read live project/sequence metadata and can use FCPXML artifact
operations when `FRAMEKIT_FCPXML_PATH` is configured. It cannot mutate the open
Final Cut timeline. Validate the native focus, Blade, range-delete, and
trim-to-duration contracts with:

```sh
pnpm run test:final-cut-headless
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

The socket protocol also accepts `snapshot`, `apply`, and `restore` from a live
bridge that can prove canonical guarantees. Framekit exposes that provider
through the existing `project.inspect`, `timeline.edit`, `edit.diff`, and
`edit.undo` MCP tools only when `canonicalTimelineMode` is `canonical-read` or
`canonical-write`. The bundled Workflow Extension cannot currently supply
those methods and fails them with `CAPABILITY_UNAVAILABLE`.

Canonical reads validate complete arrays, rational timeline coordinates,
unique occurrence and media identities, resolved media references, storyline
relationships, and an active project/sequence catalog entry. Canonical apply
responses must include the resulting revision; Framekit uses it for
compensating rollback if the immediate snapshot read fails. When an FCPXML
snapshot/mutation pair is configured, that artifact provider remains the
canonical MCP source and never inherits `timelineWrite` from a separate live
bridge.

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

If focus recovery needs to be retried explicitly, call `editor.native.focus`. It
performs a bounded Accessibility-only focus attempt and returns the same UI
diagnostics as `editor.native.inspect`; it never selects a project, moves the
playhead, or changes timeline content. When the visible Framekit extension
window overlaps Final Cut, preflight detects it, minimizes it through
Accessibility, raises the timeline window, and verifies the focused window
after every attempt. It never clicks the Framekit close button. An overlay that
cannot be minimized returns `FINAL_CUT_NATIVE_OVERLAY_BLOCKED`.

## Importing local media

With native writes enabled, import a local video or audio file into the active
Final Cut Browser with:

```json
{
  "path": "/absolute/path/to/interview.mov"
}
```

Call `editor.native.media.import` with the local file path. Framekit checks that
the path is a readable file before opening Final Cut's import UI, waits for the
basename to appear in Browser search, and returns `mediaHandle`, `sourcePath`,
`name`, and an inferred `kind` (`video` or `audio`). The returned media handle
can be passed to `editor.native.media.select` and
`editor.native.timeline.locate`. The handle is stable for the current native
session and does not itself insert the asset into the timeline.

Invalid paths fail before any import UI command. If Final Cut does not expose
the imported asset before the bounded wait expires, Framekit returns
`FINAL_CUT_NATIVE_MEDIA_IMPORT_TIMEOUT`. If polling finds only pre-existing
same-name results, it returns `FINAL_CUT_NATIVE_MEDIA_IMPORT_PRE_EXISTING`; if
multiple newly appearing same-name results are found, it returns
`FINAL_CUT_NATIVE_MEDIA_IMPORT_AMBIGUOUS`. A single newly appearing result with
an immutable source identity is accepted even when a same-name result existed
before import. A Browser result without an immutable source identity is never
accepted and returns `FINAL_CUT_NATIVE_MEDIA_IMPORT_IDENTITY_UNAVAILABLE`.
If Final Cut does not expose a ready Media Import window, folder sheet, or import
button, the bounded UI step returns `FINAL_CUT_NATIVE_MEDIA_IMPORT_UI_UNAVAILABLE`.

## Live Browser search and Blade

With native writes enabled, use `editor.native.media.target` for the common
case where an agent has a media query and needs one safe timeline target. It
performs Browser search, media selection, unique-occurrence lookup, and
timeline selection as one bounded operation. Success returns the selected
media, occurrence handle, and observed live `playheadTime`. Missing or
ambiguous media/occurrences, unavailable shared source-media identifiers, or
unavailable live playhead state, fail closed with distinct errors. Same-name
media is never used as a fallback for timeline targeting.

For a stepwise workflow, use the live UI workflow in this order:

1. Call `editor.native.media.search` with a Browser query, or import a local
   file with `editor.native.media.import`.
2. Call `editor.native.media.select` with one returned `mediaHandle`.
3. Call `editor.native.timeline.locate` with that handle.
4. Require exactly one returned timeline occurrence.
5. Call `editor.native.blade.preview` with its `occurrenceHandle`.
6. Call `editor.native.blade.execute` with the expiring `previewToken`.

Handles are bound to the current Final Cut UI state. A changed selection,
sequence, or expired preview causes a fail-closed error. Blade execution
verifies that Final Cut exposes two resulting segments after the command.

## Native media insertion

With native writes enabled, append or insert selected Browser media through the
same preview/execute safety boundary:

1. Call `editor.native.media.search` with a Browser query.
2. Call `editor.native.media.select` with exactly one returned `mediaHandle`.
3. Call `editor.native.media.append.preview` to append at the end of the active
   sequence, or `editor.native.media.insert.preview` to insert at the current
   `playheadTime`.
4. Confirm the returned media handle, insertion time, sequence, current
   duration, and revision before executing the preview token.
5. Call the matching `.execute` tool. Framekit uses Final Cut's native Append
   (`E`) or Insert (`W`) command and verifies that the live sequence duration
   increased and that the live revision changed.
6. Use `editor.native.undo` with the returned `operationId` when the insertion
   should be rolled back. Undo verifies restoration of the prior duration and
   a new live revision.

Native Browser import, search, selection, and selected-media append operations
focus Final Cut's Browser automatically through Accessibility automation. A
user does not need to click the Browser pane first.

When Browser search cannot expose the selected item through its usual media
role, use `editor.native.media.append.selected.preview` and
`editor.native.media.append.selected.execute`. This path requires Final Cut
to expose exactly one selected Browser item with a stable `AXIdentifier`; it
does not fall back to screenshot text or coordinate-only identity. The
selected identity is revalidated immediately before the Append command.

Insertion previews expire and fail closed when the selected media handle,
sequence, revision, duration, or insert playhead changes. The live Workflow
Extension remains a read-only state source; the guarded Node-side native
adapter performs the visible Final Cut command and post-command verification.

## Native range deletion and duration trimming

Native range operations use rational frame times and a preview/execute flow:

1. Call `editor.native.delete-range.preview` with `start` and `end`, or
   call `editor.native.trim-to-duration.preview` with the requested `duration`.
2. Confirm the returned range, expected resulting duration, sequence, and
   revision with the user before making a destructive edit.
3. Call the matching `.execute` tool with the short-lived `previewToken`.
4. Verify the returned live duration and use `editor.native.undo` if the user
   requests a rollback.

Native Undo records the enabled operation-specific Final Cut menu command (for
example, `Undo Delete Range` or `Undo Blade`) and invokes that exact command.
The returned native operation ID is session-scoped. Undo fails closed if the
timeline revision changed, the current Undo command no longer matches the
recorded operation, or Final Cut does not expose a new revision restoring the
pre-edit state.

`delete-range` is limited to the primary storyline and ripple-deletes the
selected range. `trim-to-duration` preserves the beginning of the sequence and
deletes everything after the requested duration. A target duration that is
already at or beyond the current duration returns a verified no-op.

## Native title placement

Native titles use the installed Motion-template registry and a guarded
preview/execute flow:

1. Call `editor.assets` with `kind: "title"` and choose one returned `assetId`.
2. Call `editor.native.title.add.preview` with that `assetId`, title `text`,
   and a positive rational `duration`. Omit `start` to use the current
   playhead; provide `start` to place the title across an explicit range.
3. Confirm the returned title, range, sequence, and revision, then call
   `editor.native.title.add.execute` with the short-lived preview token.
4. Confirm the returned selected title, changed revision, duration metadata,
   and Undo command. Use `editor.native.undo` with the returned `operationId`
   to revert it.

The preview fails closed with `TITLE_ASSET_NOT_FOUND` for an undiscovered ID,
`TITLE_ASSET_INCOMPATIBLE` for a non-title asset, and
`FINAL_CUT_NATIVE_TITLE_RANGE_OUT_OF_BOUNDS` when the placement falls outside
the active sequence. It also returns `INVALID_OPERATION` for sub-frame or
misaligned timing and `FINAL_CUT_NATIVE_TITLE_ASSET_AMBIGUOUS` when the Titles
browser exposes multiple matching templates. The native adapter does
not invent title assets or claim canonical timeline enumeration; it uses
Accessibility automation to open Final Cut's Titles and Generators browser,
select the discovered template, apply the text, and verify the selected title
and live revision.

Before timeline-native preview or execute calls in normal native mode, Framekit activates Final Cut
Pro, waits up to two seconds for an accessible project timeline, and focuses
the timeline pane through semantic Accessibility candidates followed by
bounded lower-pane coordinate fallbacks. It does not open or select projects
automatically. If setup is incomplete, it returns one of
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
