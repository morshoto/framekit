# Final Cut Pro Live E2E Test

Status: live read-only path passed locally; hybrid document path covered by MCP
integration tests.

## Purpose

Prove that Final Cut Pro can host the Framekit Workflow Extension and that the
MCP runtime can read live project/sequence state. When an explicit FCPXML path
is supplied, separately prove canonical artifact reads and edits without
claiming that the open Final Cut timeline was mutated.

## Environment

- macOS 26.5.1
- Final Cut Pro 10.7.1
- Xcode 16.4, build 16F6
- macOS SDK 15.5
- project: `Framekit Phase 1 E2E`

## Build and connect

```sh
npm run xcode:check
bash adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/build.sh
framekit connect finalcut --development --json
```

The command detects or launches Final Cut, installs the development bundle into
the per-user Applications directory, gracefully reloads Final Cut when the
bundle replaces the installed extension, and activates the extension. Verify
the socket exists:

```sh
ls -l ~/Library/Containers/com.framekit.finalcut.workflow.extension/Data/framekit.sock
```

## MCP assertions

Use the live backend through the standard Codex MCP registration:

```sh
codex mcp add framekit -- framekit mcp --editor final-cut-live
```

The MCP `connection.status` tool should report `ready` before the live state
assertions are run.

The live MCP client should observe:

- identity backend: `workflow-extension-ipc`;
- project: `Framekit Phase 1 E2E`;
- active sequence: `Framekit Phase 1 E2E`;
- a valid playhead rational time;
- a valid sequence time range;
- revisions for active sequence, sequence range, and playhead changes.

For canonical MCP coverage, start the server with:

```sh
FRAMEKIT_EDITOR=final-cut-live \
FRAMEKIT_FCPXML_PATH=/absolute/path/to/exported.fcpxml \
framekit mcp --editor final-cut-live
```

Then verify `project.inspect`, `timeline.inspect`, `context.inspect`,
`timeline.edit`, `edit.diff`, `edit.verify`, and `edit.undo`. Configure local
JSON analyzers and Motion-template roots separately when testing media analysis
and `editor.assets`.

## Safety boundary

The live-only test must not write timeline edits, alter media, or claim full
native timeline enumeration. The FCPXML test may edit only its managed fixture
artifact. Unsupported native operations must remain fail-closed.

## Native write smoke test

Use a disposable duplicate project and select one clip manually. Do not run
this against an unsaved user project.

```sh
FRAMEKIT_FINAL_CUT_NATIVE_WRITES=1 \
framekit mcp --editor final-cut-live
```

Grant Accessibility and Automation permission to the MCP host. Verify
`editor.native.inspect` reports a frontmost Final Cut timeline and a selected
clip, then test one rename or trim operation followed by
`editor.native.undo`. Native operations are selection-scoped and do not
produce a canonical timeline diff.

## Live Browser and Blade E2E

The repeatable headed runner is guarded by an exact disposable project name:

```sh
FRAMEKIT_FINAL_CUT_E2E_PROJECT="Framekit Disposable E2E" \
FRAMEKIT_FINAL_CUT_E2E_QUERY="known-video-name" \
pnpm run test:final-cut-headed
```

It refuses to mutate Final Cut unless the native inspection reports that exact
project as frontmost. Use a duplicate project containing a known Browser video;
the runner searches, selects, locates one occurrence, Blades, verifies two
segments, undoes, and verifies the original occurrence is restored.

With the same disposable project and native opt-in, verify the complete live
workflow:

1. Search the active Browser with `editor.native.media.search`.
2. Select one result with `editor.native.media.select`.
3. Locate its active-sequence occurrences with
   `editor.native.timeline.locate`.
4. Stop if the result is ambiguous; continue only with exactly one occurrence.
5. Request `editor.native.blade.preview` and retain its short-lived token.
6. Execute `editor.native.blade.execute` before the token expires.
7. Verify two resulting segments and call `editor.native.undo`.
8. Verify the original occurrence is restored.

Do not treat Browser media names as persistent timeline IDs. Change the
selection or sequence between preview and execute to verify that stale handles
are rejected.

## Native range and duration E2E

Use the same disposable project and native opt-in to verify:

1. `editor.native.delete-range.preview` returns the requested rational range
   and expected duration.
2. `editor.native.delete-range.execute` reduces the live sequence duration by
   the requested range, then `editor.native.undo` restores it.
3. `editor.native.trim-to-duration.preview` describes the tail range after the
   requested duration.
4. `editor.native.trim-to-duration.execute` leaves the beginning intact and
   verifies the requested resulting duration, then Undo restores the original.
5. A target duration longer than the current sequence returns a verified
   no-op and does not create an undoable mutation.

The headed test must use a disposable project with known duration and must
never run against an unsaved user project.

## FCPXML publish E2E

Start the live MCP server with both `FRAMEKIT_FCPXML_PATH` and
`FRAMEKIT_FINAL_CUT_NATIVE_WRITES=1`. Run and verify `timeline.edit` against
the managed FCPXML artifact first, then call `timeline.publish.new-project`
with the resulting transaction ID.
Confirm Final Cut opens a new project with the edited content and that the
original active project remains unchanged.
