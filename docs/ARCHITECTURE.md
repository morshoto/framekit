# Architecture

Framekit owns the canonical editing state in an editor-independent runtime.
MCP transport and NLE integrations are boundary layers around that state:

```text
Local media → Framekit Project / Timeline IR → headless edits → persisted state
                                      ├── headless renderer → verified video
                                      └── explicit NLE synchronization adapter
```

The runtime owns domain types, context, transactions, diffs, editing, project
state, and verification. The MCP server only exposes those runtime contracts.
Renderer providers consume canonical state to produce video; NLE adapters are
explicit downstream synchronization capabilities and cannot replace or
silently overwrite canonical state.

The normal editing path is headless: it does not require Final Cut Pro to be
installed, open, or frontmost. Final Cut-specific behavior remains behind an
adapter boundary and is never an implicit fallback for a failed headless
operation.

`FcpxmlDocumentAdapter` reads and writes an ordered FCPXML interchange artifact;
it does not claim to mutate the open Final Cut session. The
`FinalCutSessionAdapter` composes that document provider with live state and
optional native capabilities. Live metadata and canonical timeline state are
therefore separate surfaces, and unavailable capabilities must fail closed.

Read the detailed architecture documents for the individual boundaries:

- [Headless core and source of truth](./architecture/headless-core-ssot.md)
- [Runtime boundaries](./architecture/runtime-boundaries.md)
- [Backend selection](./architecture/backend-selection.md)
- [Capability model](./architecture/capability-model.md)
- [`.fcpevent` shadow materialization research](./architecture/fcpevent-shadow-materialization-research.md)
- [Software Design Description](./SDD.md)
- [Architecture decision records](./adr/)
