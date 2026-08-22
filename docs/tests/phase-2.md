# Phase 2 Tests

Status: passed locally in the deterministic fixture and covered for the
configured Final Cut document session.

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
- `timeline.frame.capture` returns deterministic MCP image content plus exact
  timeline, project, sequence, clip, timecode, and optional visual metadata.
- Missing frame-capture or requested visual-analysis providers fail explicitly
  with `CAPABILITY_UNAVAILABLE`.

Run:

```sh
pnpm run test
```

The deterministic fixture remains the provider-contract proof surface. Final
Cut uses the same contracts through explicitly configured local JSON analyzers
and a read-only Motion-template registry; without those configuration values,
the corresponding capabilities remain unavailable.
