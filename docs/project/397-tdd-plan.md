# TDD Plan: Background catalog and live Final Cut project IDs do not reconcile (#397)

**Type**: Bug
**Issue**: https://github.com/morshoto/framekit/issues/397
**Complexity**: Low
**TDD Entry Point**: Add a focused reconciliation assertion that a stable-ID mismatch exposes a machine-readable target-selection blocker.

## Issue Summary

The background Final Cut library and live Workflow Extension can describe the same named project and sequence with different stable IDs. The existing reconciler correctly refuses to promote name-only evidence, but the `project.list` response needs an explicit target-selection blocker so callers can distinguish an unresolved target from an ordinary metadata-only listing.

## Issue Excerpt

> reconcile the same project and sequence by stable identity, or fail closed with a clear target-selection blocker.

## Scope

**In scope**

- Preserve the existing fail-closed stable-ID, name-only, ambiguous, and stale behavior.
- Add a structured `target-selection-required` blocker to unresolved or stale catalog reconciliation results.
- Preserve the live/catalog identity details and keep canonical read/write capabilities unavailable.
- Document and test the MCP response shape.

**Out of scope**

- Inferring a stable ID from project or sequence names.
- Adding project activation to the bundled Workflow Extension or background library provider.
- Treating headed, metadata-only, FCPXML, or fixture evidence as canonical-live proof.

## Behaviour Inventory

| ID | Behaviour | Test Level | First Test File | Notes |
| --- | --- | --- | --- | --- |
| B1 | Matching project and sequence stable IDs returns active IDs without a blocker. | Unit/integration | `tests/integration/project-catalog-reconciliation.test.ts` | Existing stable-match regression remains green. |
| B2 | Different live/catalog IDs with matching names remain unresolved and expose a target-selection blocker with both identity records. | Unit/integration | `tests/integration/project-catalog-reconciliation.test.ts` | Name-only evidence never authorizes a target. |
| B3 | Ambiguous names and live target/revision drift remain unresolved/stale and expose the same blocker. | Unit/integration | `tests/integration/project-catalog-reconciliation.test.ts` | Candidate IDs and stale reason remain intact. |
| B4 | MCP `project.list` preserves the blocker while canonical capabilities remain unavailable. | MCP integration | `tests/integration/background-catalog.test.ts` | Transport serialization is part of the contract. |
| B5 | Headed project-selection evidence continues to require matched stable IDs. | Headed E2E | `scripts/final-cut-project-selection-headed-e2e.mjs` | Existing runner is fail-closed; live run is environment-gated. |

## Regression Reproduction

- **Reported failure**: the live provider reports `active-project` while the background catalog reports a different stable project and sequence ID; reconciliation is unresolved.
- **Expected result**: return precise live/catalog identity provenance and an explicit target-selection blocker, or a stable-ID match when supported evidence proves one.
- **Regression test**: `tests/integration/project-catalog-reconciliation.test.ts` and `tests/integration/background-catalog.test.ts`.
- **Failure assertion**: `reconciliation.blocker.code === "target-selection-required"` for the mismatch, with no active IDs.
- **Suspected layer**: runtime project-catalog reconciliation and its MCP provenance surface.

## Acceptance Criteria as Tests

| Acceptance Criterion | Test ID | Test Name |
| --- | --- | --- |
| Same target reconciles by supported stable identity or explains why it cannot. | B1/B2 | `stable project and sequence IDs reconcile...`; `stable-ID mismatch requires target selection` |
| Matching does not rely on project or sequence names alone. | B2/B3 | `name-only matches remain unresolved...`; `ambiguous ... remain unresolved...` |
| Project and sequence provenance is preserved in MCP responses. | B2/B4 | `MCP project.list preserves ... blocker and provenance` |
| Target changes during reconciliation are stale and blocked. | B3 | `target changes return a stale catalog...` |
| Unresolved reconciliation never promotes metadata-only state to canonical read/write capability. | B4 | `unresolved catalog reconciliation keeps canonical capabilities unavailable` |
| Headed validation remains stable-ID and target-bound. | B5 | `test:final-cut-project-selection-headed` |

## Test-First Implementation Cycles

### Cycle 1: Structured target-selection blocker

**Red**

- Add `stable-ID mismatch requires target selection` to `tests/integration/project-catalog-reconciliation.test.ts`.
- Assert the existing mismatch provenance, no active IDs, and the new blocker shape.
- Run: `PATH=<pinned-toolchain>:$PATH pnpm exec tsx --test tests/integration/project-catalog-reconciliation.test.ts`.

**Green**

- Add the typed blocker to `packages/runtime/src/domain/context.ts`.
- Populate it in `packages/runtime/src/context/project-catalog.ts` for unresolved and stale outcomes only.
- Run the focused reconciliation test.

**Refactor**

- Keep blocker construction centralized and preserve the existing reason and diagnostics fields.
- Re-run the focused reconciliation test while green.

### Cycle 2: MCP and capability boundary

**Red**

- Extend `tests/integration/background-catalog.test.ts` to assert the serialized blocker for the reported mismatch.
- Retain assertions that active IDs are absent and canonical read/write descriptors are unavailable.
- Run the focused background-catalog suite.

**Green**

- Use the existing provenance serialization path; make only the smallest adapter/MCP change if the response loses the new field.
- Do not add a name-based fallback or canonical capability.
- Run both focused suites.

**Refactor**

- Update `docs/mcp/protocol.md` and `docs/architecture/capability-model.md` to describe the blocker contract.
- Re-run both focused suites and the script syntax check.

### Cycle 3: Headed evidence and final verification

**Red**

- Add or update the deterministic contract assertion that the headed runner accepts only matched stable IDs and fails closed otherwise.
- Run `node --check scripts/final-cut-project-selection-headed-e2e.mjs`.

**Green**

- Keep the existing headed runner behavior if it already satisfies the contract; otherwise make the smallest assertion/documentation adjustment.
- Run the opt-in headed command only when Final Cut, the disposable project, and required permissions are available.

**Refactor**

- Review the complete diff for evidence-tier and target-binding boundaries.
- Run the repository validation gates.

## Affected Files

| File | Action | TDD Role | Description |
| --- | --- | --- | --- |
| `docs/project/397-tdd-plan.md` | Create | Plan | Issue-derived TDD execution plan. |
| `tests/integration/project-catalog-reconciliation.test.ts` | Modify | Red | Blocker regression at the runtime seam. |
| `packages/runtime/src/domain/context.ts` | Modify | Green | Typed reconciliation blocker. |
| `packages/runtime/src/context/project-catalog.ts` | Modify | Green | Fail-closed blocker construction. |
| `tests/integration/background-catalog.test.ts` | Modify | Red | MCP provenance and capability contract. |
| `docs/mcp/protocol.md` | Modify | Refactor/docs | Public response contract. |
| `docs/architecture/capability-model.md` | Modify | Refactor/docs | Metadata-only safety boundary. |

## Test Commands

**Focused cycle commands**

```bash
PATH=<pinned-toolchain>:$PATH pnpm exec tsx --test tests/integration/project-catalog-reconciliation.test.ts
PATH=<pinned-toolchain>:$PATH pnpm exec tsx --test tests/integration/background-catalog.test.ts
node --check scripts/final-cut-project-selection-headed-e2e.mjs
```

**Final verification**

```bash
PATH=<pinned-toolchain>:$PATH pnpm install --frozen-lockfile
PATH=<pinned-toolchain>:$PATH pnpm run build
PATH=<pinned-toolchain>:$PATH pnpm run test
PATH=<pinned-toolchain>:$PATH pnpm run check:boundaries
```

The headed command is evidence-gated. If unavailable, report the exact native capability blocker and do not promote deterministic or metadata evidence.

## Risks and Mitigations

- **Risk**: a name-only match becomes an authorized target.
  **Mitigation**: assert no active IDs and require `target-selection-required` for unresolved results.
- **Risk**: a stale target is presented as current.
  **Mitigation**: retain before/after target and revision tests and require the blocker on stale results.
- **Risk**: metadata is mistaken for canonical proof.
  **Mitigation**: retain canonical capability assertions and document the evidence boundary.

## Definition of Done

- [ ] The reported mismatch has a deterministic regression test.
- [ ] Stable matches remain the only path to active IDs.
- [ ] Unresolved/stale results carry a structured target-selection blocker.
- [ ] MCP provenance preserves live/catalog identity details.
- [ ] Canonical read/write capabilities remain unavailable for unresolved metadata.
- [ ] Focused and full repository validation pass.
- [ ] Headed validation is run or its exact unavailable state is recorded.
