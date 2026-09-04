# Final Cut Pro live bridge

This directory contains the in-process half of Framekit's live Final Cut Pro
adapter. It must run as a macOS Workflow Extension hosted by Final Cut Pro;
the Node MCP process must never attempt to load `ProExtensionHost` itself.

## Build with full Xcode

From the repository root, before opening the project, run
`pnpm run xcode:check`. The checked-in native baseline is Xcode 16.4 with the
macOS 15.5 SDK; see
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

## CodeQL Swift extraction

The CodeQL workflow keeps Swift analysis separate from the native build. Its
manual `xcrun swiftc` step type-checks the bridge source together with the
checked-in `.github/codeql/FinalCutWorkflowExtensionShim.swift`, a pure-Swift
declaration shim for the host and minimal AppKit surface, enabled only by
`FRAMEKIT_CODEQL`. Direct compiler invocation avoids Xcode project orchestration,
static-library linking, App Intents metadata generation, and extension packaging
that are not needed for CodeQL extraction. It does not invoke `build.sh` or link
the private host framework.
The CodeQL job and extraction step are limited to twenty-five and fifteen minutes.
The standalone Swift CI workflow remains the native gate for Xcode project
validation and type-checking.

The extension publishes a newline-delimited JSON protocol on
`FRAMEKIT_FINAL_CUT_SOCKET`, defaulting to
`~/Library/Containers/com.framekit.finalcut.workflow.extension/Data/framekit.sock`.
Framekit connects with:

```sh
FRAMEKIT_EDITOR=final-cut-live pnpm run mcp
```

Set `FRAMEKIT_FINAL_CUT_SOCKET` explicitly when using a non-default socket.

Supported metadata requests are `capabilities`, `state`, and `changes`. The
additive canonical requests `snapshot`, `apply`, and `restore` are recognized
but fail with `CAPABILITY_UNAVAILABLE` because this bridge reports
`canonicalTimelineMode: metadata-only`. The bridge
reports active project metadata and a project-scoped sequence identity derived
from the current sequence name, plus rational playhead time, selected sequence
range, and observer-backed change events. The sequence identity is not an
immutable host identifier; native handles fail closed when it changes. It
deliberately reports
`editor.timelineSnapshotRead: false`: the public Workflow Extension proxy does not promise a
complete clip/media enumeration API, so Framekit fails closed instead of
fabricating an empty canonical timeline.

Project catalog and selection requests are not advertised by this bridge. The
public host API exposes only the active sequence, so callers receive
`CAPABILITY_UNAVAILABLE` rather than an inferred project browser.

The local build is ad-hoc signed for development. From the repository root,
`pnpm run framekit -- connect finalcut`
installs the containing app into the user's Applications directory and
activates Framekit through Final Cut's Extensions menu. Release artifacts must
be Developer ID signed and notarized before distribution.
