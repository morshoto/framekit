# Deterministic MCP evaluation

The MCP evaluation suite checks the registered request/response contract with
the deterministic in-memory editor. It does not launch Final Cut Pro, touch
private media, or depend on a clock, socket, or user interface.

Run the suite and print its machine-readable summary with:

```sh
pnpm run evaluate
```

The same scenarios run as part of the normal test command:

```sh
pnpm run test
```

## Scenarios and metrics

The fixture covers active-project selection, media targeting, music-media
targeting, rename/trim/gain/ripple-delete/marker editing, transition and title
asset discovery, export capability behavior, invalid requests, and verified
Undo. Media import, music application, title application, and transition
application are intentionally measured as unavailable because those MCP tools
are not part of the current contract; the evaluator treats a missing tool as a
passing fail-closed capability result rather than pretending the workflow is
supported.

Each scenario checks its postcondition (or expected error). The report
separates scenario correctness from capability coverage: an unavailable
workflow may pass its fail-closed expectation while still lowering the
capability coverage rate. Category metrics expose supported and unavailable
counts separately. The scenario-consistency metric checks that each fixture
declares the same primary tool as its final request; it is intentionally not
called intent-mapping accuracy because this suite does not run an external
planner.

The command exits non-zero if any scenario or postcondition fails, making it
suitable for CI. The deterministic suite is separate from the optional live
Final Cut procedure documented in
[`final-cut-live-e2e.md`](./final-cut-live-e2e.md); a green deterministic report
does not claim that a Workflow Extension socket or native UI permissions are
available.
