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

Run:

```sh
npm test
```

The suite passed 12 tests on 2026-08-16. These tests exercise runtime and
adapter contracts without exporting media.
