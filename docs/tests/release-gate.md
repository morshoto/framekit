# v0.0.3 Closed-Loop Speech Editing Release Gate

The release gate exercises the `filler-removal` and
`dialogue-normalization` Skills through the generic MCP surface. Its controlled
corpus is repository-owned and contains no private media.

## Local commands

Run the focused tests with:

```sh
pnpm run test:release-gate
```

Run the executable gate and retain an immutable evidence bundle with:

```sh
pnpm run release-gate --output-dir artifacts/release-gate/local-run
```

The output contains `report.json` with sanitized workflow results, plans,
operations, canonical diffs, digests, and capability boundaries, plus
`manifest.json` with the corpus version, report hash, workflow count, and gate
status. Reusing an evidence directory is rejected.

## Controlled corpus

Filler-removal cases cover obvious and multi-filler speech, low confidence,
unsafe and overlapping boundaries, protected segments, and induced verification
rollback. Dialogue-normalization cases cover quiet, loud, already-normalized,
silent, no-dialogue, peak-risk, gain-clamp, and induced verification rollback.

Safe filler cases are measured against the 95% successful-verification target.
Skipped and rolled-back cases remain in the attempted report and must preserve
the original canonical digest.

## Capability evidence

The deterministic fixture result is separate from adapter and live evidence.
The combined v0.0.3 report still marks the FCPXML speech-editing family
unsupported because filler-removal requires timeline write guarantees. The
dialogue-normalization Skill has separate deterministic artifact coverage for
clip-level `set-gain`; that result is FCPXML evidence, not proof of a headed
open-project Final Cut edit. Live Final Cut remains unsupported unless a
documented opt-in headed run is requested; the bundled Workflow Extension is
metadata-only and never supplies fixture data. An unsupported capability is not
a passing proof of autonomous open-project Final Cut support.

The CI report keeps deterministic correctness, adapter coverage, live Final Cut
evidence, and unsupported capabilities in separate fields.

The Basic Final Cut Editing MVP has a separate executable fixture gate. Run it
with `pnpm exec tsx --test tests/integration/basic-editing-mvp.test.ts` to
verify import, placement, preview, execute, verification, transaction-bound
export evidence, and Undo without Final Cut. CI reports this gate separately
from the broad unit/integration suite; its fixture results do not promote live
Final Cut capability.
