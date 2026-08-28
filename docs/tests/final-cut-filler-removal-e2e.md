# Headed Final Cut filler-removal evidence

This runner proves the complete issue #69 workflow against a disposable live
Final Cut target:

1. inspect canonical-write capabilities and live project/sequence identity;
2. inspect the canonical timeline at the requested range;
3. analyze speech and preview high-confidence filler ranges;
4. execute revision-guarded native timeline writes;
5. re-analyze the affected clip and verify adjacent transcript continuity;
6. inspect the diff and restore the original timeline with `edit.undo`; and
7. emit an allowlisted evidence summary.

The deterministic fixture workflow is covered by the regular test suite. It is
separate from this headed run: fixture speech and timeline data are not live
Final Cut proof, and live evidence must not contain private media paths or raw
snapshots.

## Preconditions

Use a disposable project and a canonical live bridge that advertises
`canonical-write`, complete timeline snapshots, project/sequence identity,
read-after-write, rollback, and speech analysis. The bundled Workflow
Extension is currently metadata-only, so this runner must fail closed with
`CAPABILITY_UNAVAILABLE` until a canonical bridge is installed.

Set the project and selected timeline range in seconds:

```sh
export FRAMEKIT_FINAL_CUT_E2E_PROJECT="Disposable filler fixture"
export FRAMEKIT_FINAL_CUT_E2E_RANGE_START="0"
export FRAMEKIT_FINAL_CUT_E2E_RANGE_END="10"
export FRAMEKIT_SPEECH_ANALYZER="/absolute/path/to/speech-analyzer"
```

The analyzer receives the normal Framekit `AnalysisInput` JSON, including the
canonical project snapshot, media reference, and requested range. It must
return typed `SpeechWord` records with timestamps and `filler: true` only for
words it can classify confidently.

Run from the repository root:

```sh
pnpm run test:final-cut-filler-headed
```

The JSON output is a sanitized summary. Preserve any raw benchmark logs or
live diagnostics separately from the reviewable evidence document.
