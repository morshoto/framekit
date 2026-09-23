# Skill authoring guide

Skills are editor-independent editing knowledge. A Skill author provides a
versioned `SkillManifest` and a separate `SkillHandler`; the handler receives a
read-only planning context and returns semantic operations. It never imports an
MCP SDK, Final Cut adapter, Accessibility command, or editor-specific API.

## Manifest

```ts
const manifest: SkillManifest = {
  contractVersion: 1,
  id: "example.add-marker",
  version: "1.0.0",
  title: "Add marker",
  description: "Add a review marker at a requested position.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      start: { type: "number", minimum: 0 },
    },
    required: ["name", "start"],
    additionalProperties: false,
  },
  // Optional values resolved by the version-pinned handler.
  defaults: { start: 0 },
  requirements: {
    type: "operation",
    operation: "add-marker",
  },
};
```

The ID is stable across releases. The version is semantic and is pinned by
preview tokens. Optional manifest defaults are part of that version and are
copied into `plan.normalizedInput` before planning. Input schemas reject
missing, unknown, or incorrectly typed values before planning. Requirements use
`allOf` and `anyOf` trees over editor capabilities, analyzer capabilities, and
explicit semantic operations.

## Handler, plan, preview, and execution

The handler normalizes validated input and receives a `SkillPlanningContext`
containing only a project snapshot, runtime capabilities, base revision, and
optional read-only analysis functions. It returns a `SkillPlan` payload with
semantic operations, affected timeline ranges, warnings, and optional
verification policy. It does not mutate state.

The runtime then creates a non-mutating preview and a short-lived single-use
token. Execution accepts only that token, checks the pinned base revision and
current requirements, and sends the operations through the transaction manager.
The runtime re-observes the result, applies verification, and returns a
`SkillExecution` containing transaction IDs, verification evidence, and the
rollback result. Verification failure must restore the complete pre-edit state;
unknown, expired, reused, or stale tokens fail closed.

## Scope

The v0.0.2 contract includes in-process registration, capability resolution,
preview sessions, generic MCP tools, and the neutral `add-marker` conformance
fixture. v0.0.3 contains product workflows such as filler removal and dialogue
normalization. v0.0.4 is reserved for observability and workflow history after
the safety contract is stable. Dynamic third-party loading, sandboxing, and
persistent sessions are not part of this API.
