# Generic MCP Skills

Framekit Skills describe editing knowledge and use generic MCP tools. A Skill
contains no Final Cut-specific commands; editor and analyzer capabilities are
resolved by the runtime before mutation.

## Discovery

Call `skill.list` to enumerate versioned Skills and `skill.inspect` with a Skill
ID to read its requirements, preview tool, and execute tool. The v0.0.3 Skills
are:

| Skill | Version | Workflow |
| --- | --- | --- |
| `filler-removal` | 1 | speech analysis, safe deletion, re-analysis, verification, rollback |
| `dialogue-normalization` | 1 | dialogue measurement, bounded gain, re-measurement, verification, rollback |

## Execution contract

Use `skill.preview` with `skill` and an `arguments` object. Preview is
non-mutating and returns the plan, evidence, authorized operations, expected
diff, warnings, and a short-lived token when mutation is safe. Use
`skill.execute` with the same Skill ID and token. Execution accepts only the
runtime-issued token and returns a verified or rolled-back transaction.

`filler-removal` skips low-confidence, ambiguous, overlapping, or protected
speech rather than choosing a cut in natural-language code. It re-analyzes
affected speech and preserves adjacent words.

`dialogue-normalization` operates on one complete clip occurrence. It measures
dialogue loudness and true peak before planning gain, returns `NO_OP` for clips
inside tolerance, and returns `SKIP` for silence, missing dialogue, invalid
measurements, clamp violations, or peak risk. Verification uses a new
post-write measurement rather than the estimate.

Both workflows require canonical read, supported timeline write, read-after-write,
analysis, and rollback capabilities. Missing capabilities fail closed before
mutation. The generic surface does not expose or require Final Cut-specific
commands.
