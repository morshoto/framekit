# Final Cut Pro live bridge

This directory contains the in-process half of Framekit's live Final Cut Pro
adapter. It must run as a macOS Workflow Extension hosted by Final Cut Pro;
the Node MCP process must never attempt to load `ProExtensionHost` itself.

## Build with full Xcode

Before opening the project, run `npm run xcode:check`. The checked-in native
baseline is Xcode 16.4 with the macOS 15.5 SDK; see
[`nix/xcode-version.json`](../../../../nix/xcode-version.json).

The checked-in XcodeGen project supplies the container app, extension target,
local declarations for the SDK surface, the `com.apple.FinalCut.WorkflowExtension`
registration metadata, and the `_ProExtensionMain` entry point. This is useful
on machines where Xcode 16.4 does not ship the Workflow Extension template.
The extension is hosted by Final Cut Pro; the Node MCP process never loads the
Pro extension frameworks itself.

For this repository's local build, prepare the Final Cut framework path and
build with:

```sh
bash adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/build.sh
```

The extension publishes a newline-delimited JSON protocol on
`FRAMEKIT_FINAL_CUT_SOCKET`, defaulting to `/tmp/framekit-finalcut.sock`.
Framekit connects with:

```sh
FRAMEKIT_EDITOR=final-cut-live npm run mcp
```

Set `FRAMEKIT_FINAL_CUT_SOCKET` explicitly when using a non-default socket.

Supported requests are `capabilities`, `state`, and `changes`. The bridge
reports active project/sequence metadata, rational playhead time, selected
sequence range, and observer-backed change events. It deliberately reports
`editor.timelineSnapshotRead: false`: the public Workflow Extension proxy does not promise a
complete clip/media enumeration API, so Framekit fails closed instead of
fabricating an empty canonical timeline.

The local build is ad-hoc signed for development. Final Cut Pro must discover
the containing app and the user must activate Framekit from its Extensions
button before the socket is created.
