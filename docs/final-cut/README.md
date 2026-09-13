# Final Cut Pro Integration

Framekit uses two distinct Final Cut backends:

- FCPXML interchange for supported canonical timeline reads and artifact writes.
- `FinalCutSessionAdapter` to compose the document and live providers.
- Configurable local JSON analyzers, filesystem Motion-template discovery, and
  opt-in headed Titles-browser discovery with provider-qualified asset IDs.
- Guarded selection-scoped native UI edits through Accessibility automation.
- A native Workflow Extension for live project/sequence metadata, playhead,
  selected range, and change events.

- [Workflow Extension](./workflow-extension.md)
- [Basic editing MVP](./basic-editing-mvp.md)
- [IPC](./ipc.md)
- [Installation](./installation.md)
- [Troubleshooting](./troubleshooting.md)
- [Native media insertion breakthrough](./native-media-insertion-breakthrough.md)
- [Native picture-in-picture](./picture-in-picture.md)
- [FCPXML operation matrix](./fcpxml-operation-matrix.md)
- [Native write and Undo investigation](./native-write-undo-investigation.md)
- [Stable timeline targets](../adr/0010-stable-timeline-targets.md)

The live bridge is deliberately narrower than the FCPXML adapter. It provides
live state and change events; canonical reads, artifact edits, verification,
and rollback use the explicitly configured FCPXML document. The open Final Cut
timeline is not automatically changed when the artifact is edited.

Native selection edits are a separate opt-in compatibility path. The target
workflow first exposes stable project, sequence, revision, media, occurrence,
and rational coordinate evidence when the provider can resolve it. Legacy
selection/playhead operations still require their headed UI preflight and use
Final Cut's own menu commands and Undo; they do not become canonical timeline
evidence merely because a selection exists.
