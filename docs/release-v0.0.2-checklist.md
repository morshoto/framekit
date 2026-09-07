# v0.0.2 release checklist

- [ ] Public Skill manifests, requirements, plans, previews, handlers, and
      executions are exported from `@framekit/runtime`.
- [ ] Requirement resolution is deterministic, structured, and fail-closed.
- [ ] The generic runtime enforces input validation, revision checks, token
      expiry/single-use behavior, transaction execution, verification, and
      rollback.
- [ ] `skill.list`, `skill.inspect`, `skill.preview`, and `skill.execute` are
      documented and delegate to runtime APIs.
- [ ] The neutral `fixture.add-marker` Skill passes in-memory/FCPXML parity and
      metadata-only live failure tests.
- [ ] `pnpm install --frozen-lockfile` passes.
- [ ] `pnpm run build` passes.
- [ ] `pnpm run test` passes.
- [ ] `pnpm run check:boundaries` passes.

Follow-up scope is explicit: v0.0.3 owns filler-removal and dialogue
normalization workflows; v0.0.4 owns observability and workflow history. This
release does not include dynamic third-party Skill loading, sandboxing, or
native live mutation claims beyond the capabilities actually advertised.
