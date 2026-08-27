# Phase 0 Tests

Status: passed locally.

Phase 0 proves the basic agent editing loop against deterministic data:

```text
read → write → read-after-write → diff
```

Run from the repository root:

```sh
pnpm run test
```

Coverage includes MCP stdio wiring, supported FCPXML reads and writes,
external revision detection, read-after-write verification, diffs, and
stale-write rejection.

Phase 0 does not prove that Final Cut Pro is open or that the native Workflow
Extension can enumerate a complete timeline.
