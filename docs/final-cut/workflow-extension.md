# Workflow Extension

The native extension is hosted inside Final Cut Pro. Swift owns access to the
Final Cut Workflow Extension API; the Node process communicates with it over a
local Unix socket.

The extension reports active project metadata, active sequence metadata,
rational playhead time, sequence time range, and observer-backed change events.

It does not currently perform timeline writes, rollback, export, playback
control, speech analysis, audio analysis, or native asset discovery.

The local build is ad-hoc signed for development and requires Xcode with the
Final Cut `ProExtensionHost` framework available.
