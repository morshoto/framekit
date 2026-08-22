# Final Cut Pro Installation

## Toolchain

Use the repository's Nix shell for Node and shell tooling:

```sh
nix develop ./nix
```

Xcode remains a host dependency. Confirm the selected version:

```sh
npm run xcode:check
```

The verified native baseline is Xcode 16.4 / build 16F6 with macOS SDK 15.5.

## End-user setup

Register the local MCP server with Codex:

```sh
codex mcp add framekit -- framekit mcp --editor final-cut-live
```

When the MCP process starts, Framekit automatically detects Final Cut Pro,
installs the signed Workflow Extension into the user's Applications directory,
launches it, activates the Framekit extension, and waits for the local socket.
No manual `ditto` or Window → Extensions step is required for a release build.
Background MCP startup does not quit or reopen Final Cut Pro.

Check the connection without starting MCP:

```sh
framekit doctor finalcut
```

The default install is per-user and does not require administrator privileges.
macOS may still ask once for permission to let Framekit activate Final Cut Pro.

## Development build

```sh
bash adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/build.sh
```

Build and connect the generated development app through Framekit:

```sh
framekit connect finalcut --development
```

The explicit `connect` command may gracefully quit and reopen Final Cut Pro
when it replaces the installed extension, so the running Final Cut session
loads the new bundle. It never force-quits Final Cut or bypasses an unsaved
changes prompt.

For a prebuilt or locally supplied artifact, set
`FRAMEKIT_EXTENSION_APP_PATH` to the `.app` bundle before running the command.
See the [live E2E test](../tests/final-cut-live-e2e.md) for the complete
read-only procedure.

## Canonical document and analysis providers

To enable project/timeline reads, artifact edits, diffs, verification, and undo
in the live MCP session, provide an exported FCPXML file:

```sh
FRAMEKIT_EDITOR=final-cut-live \
FRAMEKIT_FCPXML_PATH=/absolute/path/to/project.fcpxml \
framekit mcp --editor final-cut-live
```

The FCPXML file is the managed artifact. Framekit does not automatically
import edits into the open Final Cut timeline.

Optional local JSON analyzer commands can be configured with
`FRAMEKIT_SPEECH_ANALYZER`, `FRAMEKIT_AUDIO_ANALYZER`, and
`FRAMEKIT_VISUAL_ANALYZER`. Each receives one JSON request on stdin and
returns one typed JSON result on stdout. Motion-template discovery can be
restricted with the colon-separated `FRAMEKIT_FINAL_CUT_ASSET_ROOTS` variable.

For selection-scoped native UI edits, explicitly opt in and grant the MCP host
Accessibility and Automation permission in System Settings:

```sh
FRAMEKIT_FINAL_CUT_NATIVE_WRITES=1 \
framekit mcp --editor final-cut-live
```

Framekit activates Final Cut and focuses the timeline before timeline-native
operations using Accessibility hierarchy discovery with bounded coordinate
fallbacks. If the visible Framekit extension window overlaps the editor,
Framekit minimizes it with `AXMinimize`, raises Final Cut's timeline window,
and verifies the focused window after each attempt. It never clicks the
Framekit close button. The user must open the intended project timeline and
select the target clip; Framekit does not choose projects automatically. A
failed focus can be retried with `editor.native.focus` without changing
timeline content.
