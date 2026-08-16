# Final Cut Pro Live E2E Test

Status: passed locally, read-only, 2026-08-16.

## Purpose

Prove that Final Cut Pro can host the Framekit Workflow Extension and that the
MCP runtime can read live project/sequence state without exporting or editing
media.

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

## Safety boundary

This test must not export, write timeline edits, alter media, or claim full
timeline enumeration. Unsupported operations must remain fail-closed.
