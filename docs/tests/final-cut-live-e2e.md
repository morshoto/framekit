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

## Build and install

```sh
npm run xcode:check
bash adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/build.sh
ditto /tmp/framekit-finalcut-derived/Build/Products/Debug/FramekitFinalCutWorkflow.app \
  /Applications/FramekitFinalCutWorkflow.app
codesign --verify --deep --strict /Applications/FramekitFinalCutWorkflow.app
```

## Activate Final Cut

Open or reopen Final Cut Pro, then activate the extension:

```sh
open -a "Final Cut Pro"
osascript -e 'tell application "Final Cut Pro" to activate' \
  -e 'tell application "System Events" to tell process "Final Cut Pro" to click menu item "Framekit" of menu 1 of menu item "Extensions" of menu 1 of menu bar item "Window" of menu bar 1'
```

Verify the socket exists:

```sh
ls -l /tmp/framekit-finalcut.sock
```

## MCP assertions

Use the live backend:

```sh
FRAMEKIT_EDITOR=final-cut-live npm run mcp
```

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
