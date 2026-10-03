# TDD Plan: Active Final Cut project does not reconcile with catalog project and sequence IDs (#382)

**Type**: Bug
**Issue**: https://github.com/morshoto/framekit/issues/382
**Complexity**: Medium
**TDD Entry Point**: Extend `tests/integration/project-catalog-reconciliation.test.ts` with stable-ID mismatch and ambiguous-name assertions.

## Issue Summary

`project.list` and `editor.live.inspect` can each observe a Final Cut target, but a catalog/live identity disagreement currently collapses into a generic unresolved result. The fix must preserve both sources and explain stable-ID mismatch, ambiguity, or stale reads without promoting metadata-only evidence to canonical capability.

## Issue Excerpt

> The fix must remain fail closed: name-only matches are insufficient when stable identities disagree or cannot be proven.

## Scope

**In scope**

- Preserve project and sequence live/catalog IDs, names, match methods, and failure details in reconciliation provenance.
- Distinguish stable-ID mismatch, unique name-only fallback, ambiguous names, missing identities, background active-target disagreement, and live target/revision drift.
- Keep unresolved and stale results free of active IDs and canonical capability promotion.
- Extend the headed project-selection evidence to assert reconciled project/sequence provenance.

**Out of scope**

- Inferring stable IDs from project or sequence names.
- Adding unsupported project activation to the bundled Workflow Extension.
- Treating background catalog or live metadata as a canonical timeline snapshot or write capability.

## Behaviour Inventory

| ID | Behaviour | Test Level | First Test File | Notes |
| --- | --- | --- | --- | --- |
| B1 | Matching project and sequence stable IDs returns active IDs and records both source identities. | Unit/integration | `tests/integration/project-catalog-reconciliation.test.ts` | Existing match coverage is retained and strengthened. |
| B2 | A live stable ID absent from the catalog never becomes a canonical match, even when the name is unique. | Unit/integration | `tests/integration/project-catalog-reconciliation.test.ts` | Preserve `name-only` evidence and add a structured mismatch reason. |
| B3 | Duplicate project or sequence names are reported as ambiguous with candidate catalog IDs and no active IDs. | Unit/integration | `tests/integration/project-catalog-reconciliation.test.ts` | Name-only matching must never select an arbitrary target. |
| B4 | Live target or revision changes between before/after reads return stale provenance and no active IDs. | Unit/integration | `tests/integration/project-catalog-reconciliation.test.ts` | Existing stale tests remain regression coverage. |
| B5 | MCP `project.list` preserves reconciliation provenance, while unresolved metadata does not advertise canonical read/write capability. | MCP integration | `tests/integration/background-catalog.test.ts` | Check response shape and effective capability family. |
| B6 | The headed project-selection runner verifies stable project/sequence reconciliation before selection evidence. | Headed E2E | `scripts/final-cut-project-selection-headed-e2e.mjs` | Requires a disposable project, supported provider, and live Final Cut permissions. |

## Regression Reproduction

- **Reported failure**: the live and catalog sources describe the same named project while their stable project/sequence IDs differ, leaving only a generic unresolved result.
- **Expected result**: return an explicit unresolved or stale result with source-bound identity details; only stable-ID matches may expose active IDs.
- **Regression test**: `tests/integration/project-catalog-reconciliation.test.ts`
- **Failure assertion**: mismatch and ambiguity diagnostics are present and active IDs are absent.
- **Suspected layer**: runtime project-catalog reconciliation and its MCP provenance surface.
- **Evidence**: current `reconcileProjectCatalog` falls back to `name-only` or a generic `unresolved` result and emits only `stable project and sequence IDs could not be reconciled`.

## Acceptance Criteria as Tests

| Acceptance Criterion | Test ID | Test Name |
| --- | --- | --- |
| Active context matches by supported stable identity or explains why it cannot. | B1/B2 | `stable project and sequence IDs reconcile...`; `stable ID mismatches preserve precise diagnostics` |
| Matching does not rely on names alone. | B2/B3 | `name-only matches remain unresolved...`; `ambiguous names remain unresolved...` |
| Project and sequence provenance is preserved in MCP responses. | B1/B5 | `MCP project.list preserves ... provenance` |
| Target changes during reconciliation are stale/target-mismatch. | B4 | `target changes return a stale catalog...` |
| Unresolved reconciliation does not promote metadata-only capability. | B5 | `unresolved catalog reconciliation keeps canonical capabilities unavailable` |
| Deterministic matching, mismatch, ambiguous, stale, and name-only cases are covered. | B1-B5 | Focused reconciliation and background-catalog suites |
| Headed validation demonstrates mapping against a disposable project. | B6 | `test:final-cut-project-selection-headed` |

## Test-First Implementation Cycles

### Cycle 1: Structured mismatch and ambiguity provenance

**Red**

- Add tests for stable project/sequence IDs that do not exist in the catalog but have unique names, and for duplicate project/sequence names.
- Assert source IDs, candidate catalog IDs, explicit match methods, and a non-generic diagnostic code.
- Run: `pnpm exec tsx --test tests/integration/project-catalog-reconciliation.test.ts` using the pinned Framekit toolchain.

**Green**

- Extend `packages/runtime/src/domain/context.ts` with additive identity failure/mismatch fields.
- Update `packages/runtime/src/context/project-catalog.ts` to classify identity outcomes and build precise diagnostics while retaining fail-closed active-ID behavior.
- Run the focused reconciliation test.

**Refactor**

- Centralize identity classification and diagnostic formatting only after all focused tests are green.
- Run the focused reconciliation test again.

### Cycle 2: MCP and capability boundary

**Red**

- Add a background-catalog integration test that returns an unresolved reconciliation and asserts the MCP payload retains provenance while canonical read/write descriptors remain unavailable.
- Run: `pnpm exec tsx --test tests/integration/background-catalog.test.ts` using the pinned Framekit toolchain.

**Green**

- Make only the smallest adapter/routing change required if the new regression exposes capability promotion.
- Keep `project.list` read-only and do not add canonical fallback behavior.
- Run the focused background-catalog test.

**Refactor**

- Remove duplicated fixture setup or extract a test helper only while both focused suites are green.
- Run both focused suites.

### Cycle 3: Headed evidence contract

**Red**

- Extend `scripts/final-cut-project-selection-headed-e2e.mjs` to require `project.list` reconciliation status `matched`, stable project/sequence methods, and matching `editor.live.inspect` identity.
- Run `node --check scripts/final-cut-project-selection-headed-e2e.mjs` and the headed command when the disposable Final Cut environment is available.

**Green**

- Add the smallest headed evidence assertions and documentation needed to make the stable mapping explicit.
- Run `pnpm run test:final-cut-project-selection-headed` with the user-provided disposable target variables.

**Refactor**

- Keep evidence allowlisted and avoid recording private project paths, raw snapshots, or operation handles.
- Run syntax checks and the deterministic background/MCP suite again.

## Affected Files

| File | Action | TDD Role | Description |
| --- | --- | --- | --- |
| `tests/integration/project-catalog-reconciliation.test.ts` | Modify | Red | Mismatch, ambiguity, and provenance regression tests. |
| `packages/runtime/src/domain/context.ts` | Modify | Green | Additive typed identity diagnostics. |
| `packages/runtime/src/context/project-catalog.ts` | Modify | Green | Classify identities and preserve fail-closed reconciliation. |
| `tests/integration/background-catalog.test.ts` | Modify | Red | MCP provenance and capability boundary regression. |
| `scripts/final-cut-project-selection-headed-e2e.mjs` | Modify | Green | Headed stable mapping evidence. |
| `docs/architecture/capability-model.md` | Modify | Refactor/docs | Document diagnostic and capability boundary. |
| `docs/mcp/protocol.md` | Modify | Refactor/docs | Document response provenance and failure shape. |

## Test Commands

**Focused cycle commands**

```bash
pnpm exec tsx --test tests/integration/project-catalog-reconciliation.test.ts
pnpm exec tsx --test tests/integration/background-catalog.test.ts
node --check scripts/final-cut-project-selection-headed-e2e.mjs
```

**Final verification**

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run test
pnpm run check:boundaries
pnpm run test:final-cut-project-selection-headed
```

The headed command is evidence-gated and may remain unavailable when Final Cut Pro, the disposable target, or required permissions are absent.

## Risks and Mitigations

- **Risk**: a name fallback is accidentally treated as a stable target.
  **Mitigation**: assert no active IDs for `name-only` and `ambiguous-name` results.
- **Risk**: catalog metadata is mistaken for canonical timeline proof.
  **Mitigation**: assert metadata-only capability descriptors remain unavailable for canonical read/write.
- **Risk**: live target changes during two reads are returned as a successful mapping.
  **Mitigation**: retain before/after target and revision tests and require stale status.
- **Risk**: headed evidence leaks private environment data.
  **Mitigation**: keep the evidence summary allowlisted and record only stable target/revision fields.

## Definition of Done

- [ ] Every behaviour in the inventory has a passing deterministic test or explicit headed verification.
- [ ] Stable-ID mismatch and ambiguity have precise structured provenance.
- [ ] Active IDs are returned only for stable project and sequence matches.
- [ ] Unresolved/stale metadata never upgrades canonical capabilities.
- [ ] Each production change is justified by a prior failing test.
- [ ] Focused and repository validation commands pass.
- [ ] Headed validation is run and reported, or its exact capability/environment blocker is recorded.
