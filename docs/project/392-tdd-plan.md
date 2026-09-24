# TDD Plan: Expose compact source-bound agent context (#392)

**Type**: Feature  
**Issue**: https://github.com/morshoto/framekit/issues/392  
**Complexity**: Medium  
**TDD Entry Point**: A context contract test asserting a revision cursor, target, provenance, evidence tier, and changed-scope envelope.

## Issue Summary

`context.inspect` and `context.changes` already expose useful editing state, but
their results do not identify the source or evidence level of that state and the
changes cursor is reconstructed from a sequence number alone. The implementation
will add a compact, target-bound envelope while retaining existing detailed fields
for compatibility, and will keep canonical timeline changes distinct from live
metadata and artifact observations.

## Issue Excerpt

> Extend the `context.inspect` and `context.changes` MCP surface with revision cursors, changed-scope information, source/provider provenance, and explicit evidence tiers.

## Scope

### In scope

- Add source, provider, target, revision-cursor, evidence-tier, and changed-scope contracts to context inspection and incremental changes.
- Accept a full revision cursor at `context.changes` while retaining the existing sequence input as a compatibility path.
- Permit metadata-only live context inspection without fabricating a canonical project snapshot.
- Prevent metadata-only observations from being returned as canonical timeline changes.
- Document the new MCP response and cursor fields.

### Out of scope

- New semantic editing operations or automatic conflict resolution.
- Changes to Final Cut’s native socket protocol or headed-native proof.
- Replacing the existing detailed timeline diff fields with a new diff schema.

## Behaviour Inventory

| ID | Behaviour | Test Level | First Test File | Notes |
| --- | --- | --- | --- | --- |
| B1 | Context inspection returns a revision cursor bound to the active project/sequence and includes provider provenance and an explicit evidence tier. | Integration | `tests/integration/phase2.test.ts` | Fixture evidence remains deterministic. |
| B2 | Context inspection exposes only compact changed-scope metadata initially and preserves the existing project/media fields. | Integration | `tests/integration/phase2.test.ts` | No timeline state is duplicated in the envelope. |
| B3 | Context changes accept the returned cursor and return source-bound `from`/`to` revisions plus changed scopes. | Integration | `tests/integration/phase2.test.ts` | Existing sequence input remains supported. |
| B4 | Metadata-only live context reports live state provenance and does not require or invent a canonical project snapshot. | Integration | `tests/integration/phase1.test.ts` | The live bridge remains metadata-only. |
| B5 | Metadata-only live changes are labeled as live metadata and never appear in the canonical timeline diff slot. | Integration | `tests/integration/phase1.test.ts` | Canonical evidence must fail closed. |
| B6 | The MCP tool schema accepts a revision cursor and serializes the new envelope without dropping legacy fields. | MCP integration | `tests/integration/mcp.test.ts` | Verify both cursor and compatibility inputs. |

## Acceptance Criteria as Tests

| Acceptance Criterion | Test ID | Test Name |
| --- | --- | --- |
| `context.inspect` is compact and source-bound. | B1/B2 | `context inspection exposes a source-bound cursor and compact scope envelope` |
| `context.changes` supports observe -> changes using the cursor. | B3/B6 | `context changes accepts an inspection cursor and returns ordered provenance` |
| Evidence tiers are explicit and not conflated. | B4/B5 | `metadata-only context never claims canonical timeline evidence` |
| Existing context consumers continue to work. | B1/B6 | `legacy project and sequence context fields remain available` |

## Test-First Implementation Cycles

### Cycle 1: Domain envelope and provenance classification

**Red**

- Add assertions for `cursor`, `target`, `provenance`, `evidenceTier`, and `changedScopes` to `tests/integration/phase2.test.ts`.
- Expected failure: the current `AgentContext` has none of these fields.
- Run: `pnpm exec tsx --test tests/integration/phase2.test.ts`

**Green**

- Extend `packages/runtime/src/domain/context.ts` with the compact context contracts.
- Add the smallest runtime classification helper for fixture, artifact, canonical-live, metadata-only, and headed-native evidence.
- Run the focused phase-2 test.

**Refactor**

- Keep the new types source-neutral and reuse existing capability modes rather than duplicating provider-specific logic.
- Run `pnpm exec tsx --test tests/integration/phase2.test.ts tests/integration/phase1.test.ts`.

### Cycle 2: Runtime inspection and incremental change envelopes

**Red**

- Add tests for fixture cursor round-trip and changed-scope derivation after a clip rename.
- Add a live-only test that calls `inspectContext` without canonical snapshot support.
- Expected failure: inspection requires `readProject`, and changes have no provenance/scope envelope.
- Run: `pnpm exec tsx --test tests/integration/phase1.test.ts tests/integration/phase2.test.ts`

**Green**

- Update `packages/runtime/src/context/context-engine.ts` to build compact envelopes, use live revision fallback, and gate canonical timeline data on canonical read capability.
- Update `packages/runtime/src/context/context-service.ts` and `packages/runtime/src/runtime.ts` only as needed to carry the envelope.
- Run the focused phase-1/phase-2 tests.

**Refactor**

- Extract repeated target/provenance construction and keep legacy detailed fields unchanged.
- Run the affected integration suite.

### Cycle 3: MCP cursor contract

**Red**

- Extend `tests/integration/mcp.test.ts` to call `context.inspect`, feed its cursor to `context.changes`, and assert the serialized envelope.
- Retain one compatibility call using `{ sequence: 0 }`.
- Expected failure: the MCP schema rejects a cursor and the server reconstructs revisions from sequence only.
- Run: `pnpm exec tsx --test tests/integration/mcp.test.ts`

**Green**

- Update `apps/mcp-server/src/server.ts` with a cursor schema and compatibility parsing.
- Preserve the existing tool names and legacy response fields.
- Run the focused MCP test.

**Refactor**

- Keep cursor validation strict and centralize revision parsing.
- Run the full integration suite.

### Cycle 4: Documentation and final verification

**Red**

- Add documentation assertions/examples for cursor input, provenance, evidence tiers, and metadata-only boundaries.
- Expected failure: the MCP docs do not describe the new contract.

**Green**

- Update `docs/mcp/tools.md`, `docs/mcp/protocol.md`, and the relevant live-provider guidance.
- Run repository validation.

**Refactor**

- Review the full diff for contract drift, compactness, and evidence-tier wording.
- Re-run all required checks.

## Affected Files

| File | Action | TDD Role | Description |
| --- | --- | --- | --- |
| `docs/project/392-tdd-plan.md` | Create | Plan | Implementation-ready TDD plan. |
| `tests/integration/phase2.test.ts` | Modify | Red | Fixture cursor, provenance, and scope behaviour. |
| `tests/integration/phase1.test.ts` | Modify | Red | Metadata-only live behaviour. |
| `tests/integration/mcp.test.ts` | Modify | Red | MCP cursor schema and serialization contract. |
| `packages/runtime/src/domain/context.ts` | Modify | Green | Compact context envelope types. |
| `packages/runtime/src/context/context-engine.ts` | Modify | Green | Source-bound inspection/change construction and gating. |
| `packages/runtime/src/context/context-service.ts` | Modify | Green | Context service wiring if required. |
| `packages/runtime/src/runtime.ts` | Modify | Green | Runtime façade signatures if required. |
| `apps/mcp-server/src/server.ts` | Modify | Green | Cursor input parsing and compatibility path. |
| `docs/mcp/tools.md` | Modify | Refactor | Tool contract documentation. |
| `docs/mcp/protocol.md` | Modify | Refactor | Cursor/provenance protocol guidance. |

## Test Commands

### Focused cycle commands

```bash
pnpm exec tsx --test tests/integration/phase1.test.ts tests/integration/phase2.test.ts
pnpm exec tsx --test tests/integration/mcp.test.ts
```

### Final verification

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run test
pnpm run check:boundaries
```

## Risks and Mitigations

- **Risk**: Metadata-only live state could be mistaken for canonical timeline evidence.  
  **Mitigation**: Add an explicit evidence tier and a regression test that asserts `timeline` is absent for metadata-only changes.
- **Risk**: Requiring a full cursor could break existing MCP clients.  
  **Mitigation**: Accept the new cursor and retain the existing sequence input in the same tool schema.
- **Risk**: Making `project` optional could surprise consumers.  
  **Mitigation**: Preserve the field for canonical/fixture contexts and test live-only inspection separately.
- **Risk**: Mixed canonical and live changes may be misclassified.  
  **Mitigation**: Keep provenance per observation source and derive changed scopes independently.

## Rollout / Review Notes

- This is a backward-compatible MCP extension; no migration or feature flag is required.
- Reviewers should verify that evidence labels remain distinct: deterministic fixture, metadata-only, FCPXML artifact, canonical-live, and headed-native.
- Headed-native validation is not claimed by deterministic or metadata-only tests.

## Definition of Done

- [ ] Every behaviour in the inventory has a passing test.
- [ ] Each production change is justified by a prior failing test.
- [ ] Metadata-only context remains explicitly non-canonical.
- [ ] Focused and final verification commands pass.
- [ ] MCP and provider documentation describe the new cursor and evidence boundary.
- [ ] Each implementation step has an `update:` commit with fewer than eight words.
