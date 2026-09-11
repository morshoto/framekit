# v0.1.6 Native-Editing Release Gate

The repository-owned v0.1.6 gate records native-editing evidence without
confusing deterministic fixtures, FCPXML artifacts, metadata-only bridge
observations, canonical live edits, and headed Final Cut proof. Its versioned
manifest is [`tests/release-gate/manifest.json`](../../tests/release-gate/manifest.json).

## Local commands

Run the focused contract tests with:

```sh
pnpm run test:release-gate
```

Run the reproducible gate and retain an immutable evidence bundle with:

```sh
pnpm run release-gate --output-dir artifacts/release-gate/local-run
```

This command runs `pnpm install --frozen-lockfile`, `pnpm run build`,
`pnpm run test`, the deterministic MCP evaluation (`pnpm run evaluate`), and
`pnpm run check:boundaries` as separate repository checks. Reusing an evidence
directory is rejected.

Headed native evidence is opt-in and must target a disposable project:

```sh
pnpm run release-gate \
  --output-dir artifacts/release-gate/headed-run \
  --headed-evidence-dir artifacts/final-cut-headed
```

The headed runners must be invoked separately with the required disposable
project and consent configuration. Their JSON output can then be supplied to
the gate; no headed UI mutation occurs by default.

## Evidence tiers

| Tier | Mode | Guarantee | Default status |
| --- | --- | --- | --- |
| deterministic | headless | verified fixture preview, execute, readback, and Undo | verified |
| FCPXML artifact | headless | verified artifact write and restoration | verified when supported |
| metadata-only | headless | observed bridge identity and capability payload | verified observation |
| canonical-live | headless | canonical timeline read/write contract | unsupported for the bundled bridge |
| headed-native | headed | disposable Final Cut readback and native Undo | unrun unless opted in |

Each tier has an independent status: `verified`, `failed`, `unsupported`, or
`unrun`. An unsupported capability is not treated as a successful native edit,
and an unrun headed tier is not treated as headed proof.

The workflow matrix covers canonical live editing, picture-in-picture, built-in
title discovery and placement, masking, filler removal, and dialogue
normalization. The deterministic corpus retains the filler-removal cases
`obvious`, `low-confidence`, `unsafe-boundary`, `overlapping-speech`,
`protected-segment`, `multi-filler`, and `verification-rollback`, plus the
dialogue cases `quiet`, `loud`, `already-normalized`, `silent`, `no-dialogue`,
`peak-risk`, `gain-clamp`, and `verification-rollback`.

Canonical live Final Cut support remains distinct from metadata-only bridge
observations and requires a provider that advertises complete timeline
read/write guarantees.

## Artifacts and provenance

`report.json` contains the sanitized workflow matrix, tier records, capability
preflight payloads, revisions, verification and restoration results, repository
check statuses, and release provenance. `manifest.json` contains the report
hash, v0.1.6 manifest and release versions, tier summaries, workflow coverage,
repository-check statuses, and provenance status.

Headed records must include the disposable target identity, Final Cut and
Framekit versions, the before/after/restored revisions, and verified execute and
Undo results. Published summaries omit private paths, credentials, native
handles, operation IDs, source identities, and raw diagnostics. Raw machine
evidence remains an operator-local input rather than a committed artifact.

Release provenance keeps package, MCP server, plugin, tag, GitHub release,
workflow, npm, and native archive/checksum checks separate. Missing external
state is `unrun`; release completion is not reported until every required
provenance check is verified.

The Basic Final Cut Editing MVP remains a separate executable fixture gate. Its
results do not promote metadata-only or fixture evidence into headed Final Cut
support.
