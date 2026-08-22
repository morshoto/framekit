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

## Headless deterministic native-contract E2E

The default Final Cut validation is headless and does not launch, activate, or
focus Final Cut Pro. It uses deterministic native and MCP fixtures to verify
the same fail-closed contracts, including overlay minimization through
`AXMinimize`, timeline focus races, missing windows, Blade, range deletion,
duration trimming, and Undo:

```sh
pnpm run test:final-cut-headless
```

This is the supported validation path for Codex and CI. It does not claim that
the open Final Cut timeline was changed.

## Optional native UI validation

Final Cut Pro does not provide a supported headless Accessibility mode. Native
Blade and range edits require a visible Final Cut timeline, so they are not
part of the headless test command. The native adapter remains fail-closed and
is covered by deterministic executor tests. If a separate macOS UI smoke test
is run manually, use a disposable project and do not treat it as headless or
as a CI requirement.
