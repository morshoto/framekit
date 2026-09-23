# Non-frontmost MCP regression

The non-frontmost regression suite is a required regression gate for future
provider and routing changes. It proves that background-safe MCP workflows remain usable
when Final Cut Pro is absent, running in the background, or not timeline-focused.

## Default deterministic gate

The deterministic coverage runs as part of the repository test command:

```sh
pnpm run test
```

It covers:

- background catalog routing without a canonical snapshot request;
- disposable FCPXML artifact preview, execute, diff, verify, and undo;
- separate evidence tiers and provider provenance; and
- bounded `CAPABILITY_UNAVAILABLE` outcomes for disabled native operations.

The deterministic suite uses disposable fixtures and does not launch Final Cut,
invoke Accessibility, or inspect undocumented `.fcpbundle` internals.

## Opt-in macOS frontmost and focus gate

Run the headed harness only on a development Mac with permission to read
frontmost and focused UI state:

```sh
pnpm run test:final-cut-background-headed
```

The harness creates a disposable FCPXML artifact, starts the MCP server with
`FRAMEKIT_FINAL_CUT_HEADLESS=1`, `FRAMEKIT_FINAL_CUT_NATIVE_WRITES=0`, and
`FRAMEKIT_AUTO_CONNECT=0`, then performs only background-safe artifact calls.
It records frontmost application and timeline-focus summaries before and after
the calls. A changed frontmost application, focused state, or dialog state
fails the run. The harness itself uses `System Events` only for those external
before/after probes; the MCP subprocess has native UI automation disabled.

This gate does not bring Final Cut to the foreground, mutate an active user
timeline, or claim headed-native write support. Native writes remain covered by
the separate headed acceptance tests and their preview, readback, revision, and
Undo requirements.

## Evidence contract

Every result identifies the evidence tier and provider backend. The supported
tiers are intentionally distinct:

| Evidence tier | Meaning |
| --- | --- |
| `deterministic` | In-memory fixture behavior |
| `artifact` | Managed FCPXML file behavior |
| `metadata-only` | Observed live metadata without a canonical snapshot |
| `canonical-live` | Complete live timeline evidence from a supported provider |
| `headed-native` | Headed Final Cut UI evidence |

Artifact results retain artifact revision and digest provenance and explicitly
report `mutatesOpenTimeline: false`. Metadata-only and artifact evidence must
not be promoted to canonical-live or headed-native claims.
