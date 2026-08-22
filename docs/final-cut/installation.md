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

The Codex plugin installs the Framekit MCP integration, but it does not replace
the Final Cut Workflow Extension. Install the signed extension application from
the latest Framekit release before the first live session. The install is
per-user and does not require administrator privileges.

Configure the Framekit marketplace once:

```sh
codex plugin marketplace add morshoto/framekit
```

Open `/plugins`, install **Framekit**, and start a new Codex session. Installation
requires neither a repository checkout nor manual `codex mcp add`. The plugin
starts the published package as:

```sh
npx -y @morshoto/framekit mcp --editor final-cut-live --headless
```

Headless mode only probes an existing Workflow Extension bridge. It does not
install the extension, launch or activate Final Cut Pro, focus its windows,
request Accessibility or Automation access, or perform native destructive
edits. Open Final Cut and its Framekit Workflow Extension before asking Codex to
connect.

Start troubleshooting with `connection.status`. A missing application,
extension, or socket must remain an actionable non-ready state;
`FINAL_CUT_HEADLESS_SOCKET_UNAVAILABLE` and `CAPABILITY_UNAVAILABLE` are not
successful connections. Live metadata access also does not imply canonical
timeline snapshot or write capability: inspect the active backend's capability
flags before using project, timeline, or edit tools.

Accessibility and Automation permission are required only for an explicit
headed native-write setup. Native destructive edits retain their preview,
execute, frontmost, focus, post-command verification, and undo requirements.

Check the connection without starting MCP:

```sh
npx -y @morshoto/framekit doctor finalcut
```

In headed mode, macOS may ask once for permission to let Framekit activate Final
Cut Pro. Grant only the permissions needed by the intended workflow.

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
