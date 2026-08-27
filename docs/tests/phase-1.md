# Phase 1 Tests

Status: passed locally; live Final Cut state is documented separately.

Phase 1 extends the deterministic runtime with:

- timeline context and context revisions;
- speech and audio analyzer ports;
- transaction verification and undo;
- rollback when verification fails;
- transcript continuity checks;
- ripple-delete, marker, and signal verification policies;
- MCP exposure of the runtime.

Run from the repository root:

```sh
pnpm run test
```

The full suite exercises the runtime, MCP, and Final Cut adapter contracts.
These tests do not substitute for headed native mutation evidence or the
quantitative filler-removal benchmark in the checklist.
