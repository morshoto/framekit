# Headless Core and Source of Truth

Issue: [#464](https://github.com/morshoto/framekit/issues/464)

Status: v0.1.15 design contract

Framekit owns the desired editing state. A provider may observe or materialize
that state, but an external editor is not the authority for the normal editing
loop.

## Canonical flow

```text
read-only local media
        ↓
Framekit Project / Timeline IR
        ↓
headless structural and property edits
        ↓
revision-guarded atomic persisted state
        ├── provider-neutral render plan → headless renderer → verified video
        └── explicit NLE synchronization adapter (downstream capability)
```

The project and Timeline IR are the source of truth between every arrow. The
renderer consumes canonical state and produces an output artifact. An NLE
adapter may translate or synchronize canonical state when an explicitly
requested capability exists; it cannot silently make provider state canonical.

## Ownership and boundaries

| Boundary | Owns | Must not own or do |
| --- | --- | --- |
| `packages/runtime` domain and timeline | Project identity, sequence identity, media bindings, timeline objects, exact timing, desired properties, project revision, validation | MCP SDK types, renderer implementation details, NLE-private identifiers as canonical identity |
| Runtime application services | Headless lifecycle, edits, transactions, persistence coordination, render/verification orchestration | Foreground activation, UI automation, implicit provider fallback |
| Project store | Schema-versioned canonical documents and atomic replacement | Partial writes, unvalidated documents, history commits |
| Renderer provider | Provider-specific render plan compilation and video generation | Changing canonical project state or reading an NLE as the source of truth |
| NLE synchronization adapter | Explicit provider binding, translation, observation, and synchronization | Replacing canonical identity, guessing unsupported fields, implicit edits |
| MCP server | Transport and exposure of runtime contracts | A second project/timeline model or provider-specific domain rules |

Final Cut Pro is one possible downstream adapter. The normal headless path is
valid when Final Cut Pro is closed, when Final Cut Pro is not installed, when
another application is frontmost, and when no interactive desktop automation
is available.

## Headless invariants

The following are contract requirements, not best-effort behavior:

1. Original media is read-only. Registration binds a stable logical asset to
   observed source identity and does not rewrite, move, or replace the source.
2. Canonical identities are provider-neutral. Provider IDs may be retained in
   explicit bindings, but never become the only project, sequence, asset, or
   timeline-object identity.
3. Exact rational timing is preserved. A lossy seconds-only conversion cannot
   replace canonical timeline coordinates.
4. State writes are revision-guarded. A stale expected project revision fails
   closed; it does not merge or overwrite newer canonical state implicitly.
5. Invalid or unsupported semantics fail closed. Corrupt state, ambiguous
   media identity, unsupported operations, and incomplete provider evidence
   return an actionable failure rather than an invented default.
6. Headless operations never silently fall back to headed or native NLE
   operations. A fallback is a separate, explicit capability and result.
7. Rendering is downstream of canonical state. A renderer cannot mutate the
   project while producing an output and a successful render does not imply
   NLE synchronization.
8. Canonical encoding is deterministic. Equivalent canonical state produces
   equivalent serialized content so persistence, review, and verification can
   compare state without provider ordering noise.

The deterministic tests for this contract verify the runtime domain import
boundary and the presence of these documented guarantees. Behavioral tests for
persistence, transactions, edit operations, rendering, and video verification
belong to their respective v0.1.15 issues.

## Revision is not history

`project revision` is a concurrency and state token. It changes when the
canonical project changes and is used to reject stale previews, executions,
and persistence writes. It does not describe ancestry, user intent, or a
recoverable version graph.

`history commit` is a future user-visible versioning feature. Git-like commits,
branches, revert, and durable history are deferred and must not be inferred
from the v0.1.15 project revision.

## Provider rules

- Canonical runtime modules may define provider-neutral binding records, but
  must not import MCP transport modules or NLE adapter modules.
- Renderer and NLE providers are injected at application boundaries and are
  optional capabilities, not domain dependencies.
- Provider observations are evidence with an explicit guarantee. An
  observation cannot upgrade itself into canonical state without an explicit
  synchronization operation that validates identity, revision, coverage, and
  supported semantics.
- An unavailable renderer or adapter returns a structured unavailable result;
  the runtime does not launch, foreground, automate, or otherwise invoke an
  NLE to complete a headless request.

## Out of scope for this contract

This boundary does not define the filesystem project-store schema, media
registration API, edit operation catalog, title/transition model, render-plan
schema, renderer implementation, MCP lifecycle tools, or NLE synchronization
workflow. Those contracts build on this boundary in the remaining v0.1.15
issues. Final Cut synchronization, readback, drift detection, and conflict
handling remain outside the headless milestone's core success path.
