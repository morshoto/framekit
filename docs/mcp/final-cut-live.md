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
the MCP process. The user must keep Final Cut's timeline frontmost and select
the target clip before calling `editor.native.edit`. Native writes fail closed
when permission, focus, selection, or menu verification is unavailable.
