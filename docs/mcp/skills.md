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

`filler-removal` previews every detected candidate with its confidence,
reason codes, occurrence mapping, safe-cut evidence, and a decision of
`AUTO_APPLY`, `SUGGESTED`, or `SKIPPED`. High-confidence frame-aligned cuts
use the canonical sequence frame duration and are authorized automatically; a
`SUGGESTED` candidate requires a fresh preview with its revision-bound ID in
`selectedCandidateIds`. If canonical frame timing is unavailable, planning
fails closed. Low-confidence, ambiguous, overlapping, or protected speech is
never selected implicitly.

The Skill applies all authorized ripple deletions in one composite transaction.
Each operation carries its candidate ID, and the preview and execution details
include candidate provenance and affected diff ranges. A preview with no valid
operations executes as a verified no-op without mutating the timeline.
Execution re-analyzes the affected speech, confirms filler targets are absent,
adjacent speech remains ordered, protected speech is unchanged, the canonical
diff matches the preview, and the timeline duration changes by the authorized
deleted frames. Any failed check rolls back the complete transaction.

`dialogue-normalization` operates on one complete clip occurrence. It measures
dialogue loudness and true peak before planning gain, returns `NO_OP` for clips
inside tolerance, and returns `SKIP` for silence, missing dialogue, invalid
measurements, clamp violations, or peak risk. Verification uses a new
post-write measurement rather than the estimate.

### Dialogue normalization inputs

`dialogue-normalization@1.0.0` requires `mediaId` and `occurrenceId`. The
remaining safety policy is versioned by the manifest and resolved into
`plan.normalizedInput` when omitted:

| Input | Default |
| --- | ---: |
| `targetLufs` | -16 |
| `toleranceDb` | 0.5 |
| `maxTruePeakDb` | -1 |
| `minGainDb` | -6 |
| `maxGainDb` | 6 |
| `minDialogueDurationSeconds` | 1 |

After `project.inspect`, preview one complete occurrence through the generic
MCP surface:

```json
{
  "skill": "dialogue-normalization",
  "version": "1.0.0",
  "arguments": {
    "baseRevision": { "id": "rev-7", "sequence": 7, "timestamp": "..." },
    "mediaId": "dialogue-media",
    "occurrenceId": "dialogue-occurrence"
  }
}
```

Pass the returned token unchanged to `skill.execute`. An `APPLY` preview
contains the measured occurrence, LUFS, true peak, target, tolerance, bounded
gain, estimated peak, decision, warnings, expected diff, and token. A clip
already inside tolerance executes as a verified no-op; unsafe decisions remain
non-mutating `SKIP` results. Execution re-measures the selected range and rolls
back the complete transaction if measurement, verification, or the authorized
canonical diff fails.

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
