# v0.1.12 disposable acceptance corpus

The versioned corpus at [`tests/release-gate/v0112-acceptance.json`](../../tests/release-gate/v0112-acceptance.json)
wraps the controlled filler-removal and dialogue-normalization release-gate
workflows for v0.1.12. It records the source revision, canonical digests,
verification checks, expected recovery, and evidence tier for every result.

Run the deterministic acceptance gate and retain a fresh sanitized report with:

```sh
pnpm run acceptance:v0112 --output-dir artifacts/release-gate/v0112-local
```

The output directory must not already exist. The command runs the controlled
headless corpus plus provider-unavailable, stale-revision, and ambiguous-target
negative checks. Verification-failure and recovery scenarios must restore the
pre-edit canonical digest. No private media or Final Cut library is read by the
deterministic run.

Canonical-live and headed-native statuses remain separate from deterministic
results. To include previously captured headed records, pass an evidence
directory after running the documented disposable Final Cut runners:

```sh
pnpm run acceptance:v0112 \
  --output-dir artifacts/release-gate/v0112-headed \
  --headed-evidence-dir artifacts/final-cut-headed
```

The headed directory is an operator-local input. The report never upgrades an
unsupported or unrun tier to native proof, and the disposable-project policy
requires explicit headed consent and forbids private media.

Capture both Skill workflows using the dedicated disposable runners before
supplying that directory:

```sh
pnpm run test:final-cut-filler-headed > artifacts/final-cut-headed/filler-removal.json
pnpm run test:final-cut-dialogue-headed > artifacts/final-cut-headed/dialogue-normalization.json
```

The report continues to record canonical-live and headed-native status
independently; deterministic or artifact evidence cannot promote either tier.
