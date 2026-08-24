# Final Cut Pro Integration

Framekit uses two distinct Final Cut backends:

- FCPXML interchange for supported canonical timeline reads and artifact writes.
- `FinalCutSessionAdapter` to compose the document and live providers.
- Configurable local JSON analyzers and read-only Motion-template asset discovery.
- Guarded selection-scoped native UI edits through Accessibility automation.
- A native Workflow Extension for live project/sequence metadata, playhead,
  selected range, and change events.

- [Workflow Extension](./workflow-extension.md)
- [Basic editing MVP](./basic-editing-mvp.md)
- [IPC](./ipc.md)
- [Installation](./installation.md)
- [Troubleshooting](./troubleshooting.md)
- [Native media insertion breakthrough](./native-media-insertion-breakthrough.md)

The live bridge is deliberately narrower than the FCPXML adapter. It provides
live state and change events; canonical reads, artifact edits, verification,
and rollback use the explicitly configured FCPXML document. The open Final Cut
timeline is not automatically changed when the artifact is edited.

Native selection edits are a separate opt-in path. They operate on the clip
selected in Final Cut or the current playhead and use Final Cut's own menu
commands and Undo. They do not provide canonical clip IDs or full timeline
diffs.
