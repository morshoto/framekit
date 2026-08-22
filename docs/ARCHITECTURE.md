# Architecture

Framekit keeps the editor-independent runtime separate from MCP transport and
Final Cut integration:

```text
Agent → MCP stdio → TypeScript runtime → adapter → local IPC → Swift extension → Final Cut Pro
```

The runtime owns domain types, context, transactions, diffs, editing, and
verification. The MCP server only exposes those runtime contracts. Final Cut
adapters provide FCPXML document access, live Workflow Extension state,
optional local analysis providers, and explicitly guarded native UI actions.

`FcpxmlDocumentAdapter` reads and writes an ordered FCPXML interchange artifact;
it does not claim to mutate the open Final Cut session. The
`FinalCutSessionAdapter` composes that document provider with live state and
optional native capabilities. Live metadata and canonical timeline state are
therefore separate surfaces, and unavailable capabilities must fail closed.

Read the detailed architecture documents for the individual boundaries:

- [Runtime boundaries](./architecture/runtime-boundaries.md)
- [Backend selection](./architecture/backend-selection.md)
- [Capability model](./architecture/capability-model.md)
- [Software Design Description](./SDD.md)
- [Architecture decision records](./adr/)
