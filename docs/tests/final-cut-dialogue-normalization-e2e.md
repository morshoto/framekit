# Headed Final Cut dialogue-normalization evidence

This runner exercises the bundled `dialogue-normalization` Skill through real
MCP calls against one explicitly selected occurrence in a disposable Final Cut
project. It calls `skill.inspect` before preview, fails closed unless every
timeline, rollback, composite transaction, loudness analyzer, and `set-gain`
requirement is available, and then records preview, execution, verification,
and Undo evidence.

The preview is non-mutating and records measured LUFS, true peak, and proposed
gain. Execution must re-measure the same occurrence at the new revision, remain
within the configured loudness tolerance and true-peak ceiling, and restore the
original canonical digest through verified Undo.

## Preconditions

Use only an explicitly authorized disposable project. Do not use private media.
Configure a canonical-write Final Cut provider and a local range-bound loudness
analyzer, then identify the stable occurrence ID from a canonical inspection:

```sh
export FRAMEKIT_FINAL_CUT_E2E_PROJECT="Disposable dialogue fixture"
export FRAMEKIT_FINAL_CUT_E2E_OCCURRENCE="dialogue-occurrence-id"
export FRAMEKIT_AUDIO_ANALYZER="/absolute/path/to/loudness-analyzer"
```

Optional policy overrides are `FRAMEKIT_DIALOGUE_TARGET_LUFS`,
`FRAMEKIT_DIALOGUE_TOLERANCE_DB`, and
`FRAMEKIT_DIALOGUE_MAX_TRUE_PEAK_DB`. Run from the repository root:

```sh
pnpm run test:final-cut-dialogue-headed
```

The emitted JSON is an allowlisted headed-native summary. It is separate from
deterministic, FCPXML-artifact, metadata-only, and canonical-live evidence; an
unavailable provider or unrun workflow never upgrades either canonical-live or
headed-native status.
