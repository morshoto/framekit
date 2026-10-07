# Validation

Validation pages explain what Framekit has demonstrated, under which
conditions, and where the evidence stops.

- [Test index](../tests/README.md)
- [Test matrix](../tests/test-matrix.md)
- [MCP evaluation](../tests/mcp-evaluation.md)
- [Final Cut live validation](../tests/final-cut-live-e2e.md)
- [Release gate](../tests/release-gate.md)
- [Skill conformance](../tests/skill-conformance.md)
- [Non-frontmost MCP regression](../tests/non-frontmost-regression.md)
- [Evidence directory](../tests/evidence/)

Every validation report should identify its goal, result, environment, scope,
and limitations. Deterministic fixtures and metadata-only evidence do not by
themselves prove headed native Final Cut behavior.

## v0.1.13 incremental synchronization

The v0.1.13 headed pass combines stable target binding, canonical R0/R1
readback, ordered `timeline.changes`, compact `context.changes`, and stale
editing-session reconciliation. Run the deterministic repository gates first,
then use an unlocked macOS console with Final Cut Pro, the connected Workflow
Extension, and a disposable project:

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run test
pnpm run check:boundaries
.agents/skills/verify-final-cut-native/scripts/run-headed-check.sh canonical-read
pnpm run test:final-cut-project-selection-headed
```

Set `FRAMEKIT_FINAL_CUT_E2E_PROJECT`,
`FRAMEKIT_FINAL_CUT_E2E_PROJECT_ID`, and
`FRAMEKIT_FINAL_CUT_E2E_SEQUENCE_ID` to the intended disposable target. The
incremental runner pauses for one controlled human timeline edit and requires
explicit consent through `FRAMEKIT_FINAL_CUT_E2E_ALLOW_EXTERNAL_EDIT=1`:

```bash
FRAMEKIT_FINAL_CUT_E2E_ALLOW_EXTERNAL_EDIT=1 \
  pnpm run test:final-cut-incremental-sync-headed
```

The runner uses a temporary session directory and emits sanitized
`headed-native` evidence only after it proves target-bound R0/R1 revisions,
before/after change provenance, compact context scopes, stale blocking, and
post-reconciliation session work. A `ready` bridge, fixture result, FCPXML
artifact, or metadata-only observation is not equivalent to this headed proof.
