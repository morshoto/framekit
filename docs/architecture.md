# Architecture

Framekit is a local-first editing runtime that owns an editor-independent
project and timeline model. MCP and editor integrations are adapters around
that model:

```text
MCP clients → MCP server ─┐
                           ├→ headless application → runtime contracts → Framekit Project / Timeline IR
CLI ──────────────────────┘          ├── FCPXML document adapter
                                      └── injected headless renderer → verified video
runtime contracts ←────────────── explicit NLE synchronization adapter
```

## Component responsibilities

| Component | Responsibility |
| --- | --- |
| `packages/runtime` | Domain contracts, context, edits, transactions, diffs, and verification. |
| `packages/headless-application` | Transport-neutral headless project, edit, rough-cut, render, and approval workflows. |
| `apps/mcp-server` | MCP transport, schemas, and tool registration. |
| `adapters/final-cut/typescript` | Node-side Final Cut, FCPXML, and provider adapters. |
| `adapters/final-cut/swift-bridge` | The macOS Workflow Extension and native Final Cut boundary. |
| `packages/testkit` | Deterministic in-memory editors, analyzers, and fixtures. |

Dependencies flow toward runtime contracts. Runtime code does not import the
MCP SDK or editor adapters. Headless Framekit projects and their Timeline IR
remain the canonical editing state; editor observations and exported artifacts
do not silently replace that state.
Project persistence uses atomic persisted state updates and revision-guarded
edits. A project revision is separate from a history commit; Git-like commits
are deferred and must not be inferred from revision identifiers.

## Dependency rules

Workspace imports flow toward the runtime contracts. Imports between packages
must use a package's declared public export and the consumer must declare that
workspace dependency directly in its manifest. Relative imports are for files
inside one package. TypeScript path aliases are resolved by the boundary check
and do not grant access to another package's private files. These boundary
rules also apply to type-only imports and exports; production reachability and
cycle checks follow runtime edges.

| Source layer | Allowed workspace dependencies | External packages |
| --- | --- | --- |
| `packages/runtime` (domain and application) | None | Node built-ins only. |
| `packages/headless-application` | Runtime and Final Cut document adapter | Node built-ins only. |
| `packages/testkit` | `packages/runtime` | Node built-ins only. |
| TypeScript adapters | `packages/runtime` | `adapters/final-cut/typescript`: `fast-xml-parser`; headless adapter: Node built-ins only. |
| `apps/mcp-server` | Runtime, headless application, and both TypeScript adapters | `@modelcontextprotocol/sdk`, `zod`, and Node built-ins. |
| `apps/cli` | Final Cut adapter and headless application | Node built-ins only. |

The MCP bootstrap's fixture fallback is the sole `apps/mcp-server` import of
`packages/testkit`; keep it in `apps/mcp-server/src/main.ts`. The CLI declares
its workspace dependencies in `apps/cli/package.json`. The checker does not
permit sibling application imports or private adapter paths.

`@framekit/final-cut` is the default adapter entrypoint. Experimental SQLite,
shadow mutation, pasteboard, unattended-editing, and console-experiment APIs
are available only from `@framekit/final-cut/experimental`; default CLI and MCP
entrypoints must not reach those modules. The boundary checker also rejects
new runtime source dependency cycles. The existing Timeline IR edit/reconcile cycle
between `editing-session.ts` and `drift-reconciliation.ts` is the only
temporary cycle exception; removing it would require extracting shared
validation and reconciliation contracts beyond this gate's scope.

## State, identity, and revisions

Operations bind to stable project and sequence identities,
revision, and the affected media or occurrence identity when applicable.
`TimelineTarget` carries those stable identities and revision; rational
`frameDuration` and timeline times preserve frame-accurate values.
`playheadTime` describes the editor playhead; it is not a substitute for a
stable target or timeline revision. Read-after-write verifies a mutation
against the same target and revision contract. Canonical Final Cut reads reject
live target or revision changes during export; native edits recheck the live
revision after target resolution. Canonical revision tokens are scoped to the
provider session and change when the live revision changes.

An incremental result must match its target and revision cursor. Concurrency
conflicts and stale-write errors, ambiguous or incomplete observations, and
unavailable providers require a fresh canonical
read or a structured failure. Metadata-only observations cannot be promoted to
canonical changes, and provider changes do not upgrade the evidence guarantee.
`timeline.changes` and `context.changes` return changes in deterministic order,
with operation-specific before and after values and provider and backend provenance.

## Provider and evidence boundaries

| Evidence surface | What it establishes | What it does not establish |
| --- | --- | --- |
| Deterministic fixture | Behavior against a controlled in-memory editor. | Final Cut state or a native edit. |
| FCPXML artifact | Read, write, or verify the selected interchange artifact. | Mutation of the currently open Final Cut project. |
| Metadata-only bridge | Observed editor identity, project metadata, playhead, range, or events that the bridge exposes. | A complete canonical timeline snapshot or timeline-write capability. |
| Canonical provider | The exact read or write capabilities the provider explicitly advertises. | Any capability it does not advertise. |
| Headed-native verification | A separately authorized operation with exact-target readback and restoration evidence. | Proof for a different project, revision, extension, or operation. |

`connection.status`, `editor.inspect`, and `editing.route` report the selected
backend and operation-level capability. A missing capability must fail closed
with an explicit `CAPABILITY_UNAVAILABLE` result. Framekit does not silently fall back to Final
Cut, an external renderer, or a weaker observation and describe it as stronger
evidence.

`editor.native.media.search` treats query text literally. Queries containing
`*` or `?` return a structured unsupported error before Browser UI access.

MCP Skills use the generic `skill.list`, `skill.inspect`, `skill.preview`, and
`skill.execute` lifecycle. An execution must use the selected candidate and
the exact preview target and revision; verification and rollback status remain
part of the result.

## Headless and native editing

The normal Framekit-owned editing path is headless. It does not require Final
Cut Pro to be installed, open, or frontmost. It works when Final Cut Pro is
closed or when Final Cut Pro is not installed. The bundled Workflow Extension provides metadata
only unless a configured provider advertises more. A failed headless operation
has no implicit headed-native fallback or foreground activation.

FFmpeg headless renders normalize audio to AAC at 48 kHz mono. Verification
checks this emitted format while preserving registered source metadata; other
renderer backends are checked against their source audio metadata.

For `ripple-delete`, preview rejects ranges outside the active sequence bounds
before issuing a preview token. The structured error reports the requested
range and observed timeline bounds, including for a negative start.

Native UI edits require an explicit headed path and a separately approved
operation. Bind the preview to the exact project, sequence, occurrence, and
revision; verify the intended target and foreground state before execution;
require canonical readback; and verify Undo or rollback. If a required capability,
identity, revision, or readback is missing, stop without claiming success.
Background inspection must not click, type, activate Final Cut, or select a
project through the UI. A locked native console is a blocker; do not retry the
import or overwrite the target without a fresh approved operation.

`EditingSession` keeps desired edits provider-neutral and bound to a versioned
editable project. Reconcile changes against the original project before
materializing or publishing; the source must not be flattened into canonical
state. A canonical resync or an explicit conflict resolution is required when
the observed revision is stale. Background Final Cut inspection does not use
System Events or UI automation to select a project; an unavailable provider
remains unavailable. The project, source artifact, and active editor state
retain separate identities and evidence guarantees.

FCPXML editing is an explicit artifact operation. Publishing an artifact to a
new `.fcpbundle` is a separate operation with an explicit destination and
confirmation; a dispatch acknowledgment is not proof that Final Cut imported
it. Native acceptance requires matching project and sequence readback.

## Persistence and synchronization

Framekit-owned projects persist provider-neutral Timeline IR and revision history.
External editor state is synchronized through an adapter and reconciled
against the bound revision before applying edits. A conflict, stale revision,
or uncertain source state blocks materialization and publication until the
caller obtains a new observation or resolves the conflict. Background library
and SQLite observations retain their provider provenance and do not become a
canonical timeline solely because they contain familiar fields.
