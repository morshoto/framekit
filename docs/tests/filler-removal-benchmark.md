# Controlled filler-removal benchmark

The versioned corpus at [`tests/filler-removal/corpus.json`](../../tests/filler-removal/corpus.json)
measures the deterministic Phase 1 filler-removal workflow. Every scenario
performs filler detection and planning, a guarded ripple-delete, runtime
re-observation, and transcript verification using the in-memory editor. It
does not launch Final Cut Pro or use private media.

Run the focused contract tests with:

```sh
pnpm run test:filler-removal
```

Run the benchmark and retain a new evidence directory with:

```sh
pnpm run benchmark:filler-removal -- --output-dir artifacts/filler-removal/local-run
```

The command refuses to reuse an existing output directory. Each run retains:

- `results.jsonl`: one complete raw result per scenario, including scenario
  ID, workflow-stage evidence, revisions, canonical digests, transcript
  observations, and failure detail;
- `manifest.json`: corpus version and SHA-256, immutable benchmark
  configuration, runtime identity, raw-result SHA-256, scenario count, and
  the aggregate summary.

## Metric and failure categories

`successful-verification-rate` is the number of verification-eligible
scenarios that finish `VERIFIED` with the expected transcript, divided by the
number of scenarios whose expected outcome is `verified`. The PRD threshold is
95.0%. Expected boundary and rollback scenarios are excluded from that
denominator, but must pass by safely returning `ROLLED_BACK` and restoring the
original canonical digest. Their details remain in the raw JSONL and the
`boundary` / `rollback` failure categories.

The current corpus has four verification-eligible successful scenarios, one
overlapping-speech boundary rollback, and one controlled verification rollback;
the measured verification rate is 100.0%, above the 95.0% threshold. The
aggregate is recomputed from raw results, so the manifest is auditable without
rerunning the workflow.

CI runs the same command and uploads the run directory as the
`filler-removal-benchmark-<run-id>` artifact. This controlled fixture result is
separate from native Final Cut live capability or subjective editorial-quality
claims.
