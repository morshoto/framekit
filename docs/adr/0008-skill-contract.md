# ADR 0008: Editor-independent Skill contract

## Status

Accepted for the v0.0.2 Skill runtime.

## Context

Framekit already has specialized filler-removal and dialogue-normalization
workflows, but their manifests and handlers are coupled to the MCP server and
to individual runtime services. A reusable Skill needs a public contract that
can be inspected and planned without importing MCP or Final Cut code.

## Decision

`@framekit/runtime` owns the versioned Skill contract. A `SkillManifest` is
metadata: a stable ID, semantic version, title, description, transport-neutral
input schema, capability requirements, and optional verification defaults.

The executable `SkillHandler` is kept separate from the manifest. It receives a
read-only `SkillPlanningContext` containing a project snapshot, runtime
capabilities, and base revision. It returns semantic `WorkflowOperation`s,
affected ranges, and warnings. It never receives an editor adapter.

The lifecycle is explicitly ordered:

```text
discover → resolve → plan → preview → execute → verify → accept | rollback
```

`SkillPlan` records the pinned Skill identity, base revision, normalized input,
semantic operations, affected ranges, and warnings. `SkillExecution` records
the plan reference, transaction IDs, verification result, and rollback result.
Preview is a runtime session concern and must not mutate editor state; execution
is a runtime transaction concern and may proceed only after requirement
resolution and preview-token validation.

## Scope boundaries

- v0.0.2 defines the public contract, deterministic requirement resolution,
  in-process registration, preview sessions, generic MCP mapping, and the
  neutral conformance fixture.
- v0.0.3 builds product Skills such as filler removal and dialogue
  normalization on the generic contract.
- v0.0.4 may add observability and workflow history after the safety contract is
  stable.

Dynamic package discovery, arbitrary third-party code loading, sandboxing, and
persistent workflow history are deferred. No Skill contract type contains a
Final Cut-specific command or adapter type.

## Consequences

The runtime can validate and inspect Skills without knowing their transport or
editor implementation. Existing specialized workflows remain compatible while
they are migrated behind the generic runtime. The contract intentionally uses
semantic operations and capability names, so adapters remain responsible for
mapping those semantics to editor-specific mechanisms.
