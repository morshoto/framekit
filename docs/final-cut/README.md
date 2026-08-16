# Final Cut Pro Integration

Playhead uses two distinct Final Cut backends:

- FCPXML interchange for supported canonical timeline reads and artifact writes.
- `FinalCutSessionAdapter` to compose the document and live providers.
- A native Workflow Extension for live project/sequence metadata, playhead,
  selected range, and change events.

- [Workflow Extension](./workflow-extension.md)
- [IPC](./ipc.md)
- [Installation](./installation.md)
- [Troubleshooting](./troubleshooting.md)

The live bridge is deliberately narrower than the FCPXML adapter. It must not
be treated as a complete timeline source until Final Cut exposes a supported
native clip/media enumeration API.
