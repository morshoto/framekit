# Phase 2 Tests

Status: passed locally, deterministic runtime scope, 2026-08-16.

Phase 2 proves the Context Engine additions:

- incremental context changes can come from an adapter change feed without a
  second full project read;
- visual analysis returns scenes, subjects, motion, and keyframes through a
  replaceable analyzer port;
- media understanding combines configured speech, audio, and visual analyzers
  and attaches the result to the queryable media context;
- native assets are discoverable through filtered text, kind, and vendor
  queries;
- MCP exposes `context.inspect`, `context.changes`, `visual.analyze`,
  `media.understand`, and queryable `editor.assets`.

Run:

```sh
pnpm run test
```

The deterministic fixture is the Phase 2 proof surface. Final Cut live remains
fail-closed for visual analysis and native asset discovery because the current
Workflow Extension does not provide those capabilities.
