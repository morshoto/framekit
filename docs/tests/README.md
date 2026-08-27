# Test Documentation

These documents separate deterministic automated tests from tests requiring a
real Final Cut Pro process.

- [Phase 0](./phase-0.md): read, write, read-after-write, diff, and MCP.
- [Phase 1](./phase-1.md): context, analysis ports, transactions,
  verification, rollback, and MCP.
- [Phase 2](./phase-2.md): incremental synchronization, visual analysis,
  media understanding, and native asset discovery.
- [Deterministic MCP evaluation](./mcp-evaluation.md): fixture-backed workflow,
  failure-path, capability-coverage, and scenario-consistency metrics.
- [Clean MCP clients](./clean-mcp-clients.md): isolated Codex and Claude Code
  registration probes, stdio workflow coverage, and sanitized evidence.
- [Final Cut live E2E](./final-cut-live-e2e.md): read-only native bridge test.
- [Test matrix](./test-matrix.md): scope and evidence by backend.
- [Evidence](./evidence/2026-08-16-phase-1-live.md): sanitized local run.

The repository test command is:

```sh
pnpm run test
```

Live Final Cut tests are not part of CI because they require macOS, Final Cut
Pro, an active library, and a registered Workflow Extension.
