# Generic MCP Skills

Framekit's public Skill contract lives in `@framekit/runtime`. A manifest is
metadata and an executable handler is separate from it; handlers receive a
read-only planning context and return semantic operations. Skill implementations
must not call Final Cut or another editor adapter directly.

The lifecycle is:

```text
discover → resolve → plan → preview → execute → verify → accept | rollback
```

The v0.0.2 contract is documented in [ADR 0008](../adr/0008-skill-contract.md).

Framekit Skills describe editing knowledge and use generic MCP tools. A Skill
contains no Final Cut-specific commands; editor and analyzer capabilities are
resolved by the runtime before mutation.

## Discovery

Call `skill.list` to enumerate versioned Skills and `skill.inspect` with a Skill
ID to read its requirements, preview tool, and execute tool. The repository-owned
Skills currently exposed by the generic surface are:

| Skill | Version | Workflow |
| --- | --- | --- |
| `filler-removal` | 1.0.0 | speech analysis, safe deletion, re-analysis, verification, rollback |
| `dialogue-normalization` | 1.0.0 | dialogue measurement, bounded gain, re-measurement, verification, rollback |
| `audio-noise-reduction` | 1.0.0 | noise analysis, affected-range preview, bounded reduction, re-analysis, verification, rollback |
| `color-correction` | 1.0.0 | clip-scoped exposure, contrast, saturation, white balance, presets, verification, rollback |

## Execution contract

Use `skill.preview` with `skill`, an optional semantic `version`, and an
`arguments` object containing the inspected `baseRevision`. Preview is
non-mutating and returns the version-pinned plan, normalized input, semantic
operations, expected diff, warnings, and a short-lived runtime token. Use
`skill.execute` with only that token; the token pins the Skill ID and version,
so raw operations and editable plans cannot be submitted.

`skill.list` and `skill.inspect` include the current capability-resolution
result. Unsupported requirements are reported with exact missing leaves and
stable reason codes; they do not fall back to a fixture or another editor.

`filler-removal` skips low-confidence, ambiguous, overlapping, or protected
speech rather than choosing a cut in natural-language code. It re-analyzes
affected speech and preserves adjacent words.

`dialogue-normalization` operates on one complete clip occurrence. It measures
dialogue loudness and true peak before planning gain, returns `NO_OP` for clips
inside tolerance, and returns `SKIP` for silence, missing dialogue, invalid
measurements, clamp violations, or peak risk. Verification uses a new
post-write measurement rather than the estimate.

`audio-noise-reduction` requires an explicitly configured noise analyzer and an
editor-native noise-reduction capability. It reports revision-bound noise
measurements, affected ranges, and a bounded reduction adjustment. The runtime
re-analyzes the edited range after execution and rolls back when the configured
noise-floor threshold is not met. Missing analyzer or effect capability fails
closed before mutation.

`color-correction` accepts exposure, contrast, saturation, temperature/tint
white-balance controls, and the `neutral`, `warm`, `cool`, and `high-contrast`
presets. It records the before and after correction in the preview details and
verifies the requested values on the intended clip after execution. It requires
the editor's explicit color-correction capability; advanced grading and
unsupported native effects are outside this Skill.

Both workflows require canonical read, supported timeline write, read-after-write,
analysis, and rollback capabilities. Missing capabilities fail closed before
mutation. The generic surface does not expose or require Final Cut-specific
commands.
