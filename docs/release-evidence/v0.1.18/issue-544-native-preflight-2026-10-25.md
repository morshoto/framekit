# Issue #544 native acceptance preflight — 2026-10-25

**Result: BLOCKED before publish preview or import.** This is a read-only preflight. It does not establish new-project creation or native timeline readback.

## Candidate and preserved headless evidence

| Item | Observed identity |
| --- | --- |
| Issue worktree base commit | `89be9b391449e70fa6e46f18fbc2577d4dcb3bb8` |
| Previously approved headless candidate | `e38edce73671fc16a776ccfeba578c85ac60e3c3` |
| Persisted execution | `rough-cut-0a524437-b5d4-4060-9225-6f85b3d04934` |
| Plan digest | `0dfa95ac34ce6319f6b5c94fa623a1b5d7ba0b7b69e74c2ff971ce01dc3f3477` |
| Canonical revision | `ir:310b5990c6e8578b0d9a5a7038eff6286fe372b0bb44e4e4d476d9abad61a568` |
| FCPXML SHA-256 | `1cc01f7f092275778e45b4d6ad5d9075b7e8c1d2723346e332c849abf39db9cc` |
| MP4 SHA-256 | `52ec1e9e2e4f240e65eb5743f76e3f6216ebdc0ab9b558bad9bbe9322b124dc3` |
| Final Cut Pro | `10.7.1` |

The persisted e38 approval, execution record, MP4, and FCPXML are present locally. Fresh `shasum -a 256` results for both outputs match the recorded digests. The four source files are also present and match the recorded SHA-256 values:

| Source | SHA-256 |
| --- | --- |
| A video | `1d4d7001506d1972db2ca52dbdb30a1a98d9f11806cc07e1e4206774c54b0731` |
| B video | `3c6d84797a2a54f836f6abe379dbb4db05d8743a2f27e26470f8d0ae5980926b` |
| C video | `d64e27801ec631596ef746030e439240bb3e339ff6154a7addac510c0999931d` |
| Music | `b46293d3cfa362b9820cbd43bf4d92bbe8ac4fcb4c93026798ae363e8e6a9e33` |

These hashes identify historical approved e38 inputs. They do not approve a native preview for the current worktree commit or prove runtime/installed extension alignment.

## Current native gate

The read-only `run-headed-check.sh canonical-read` preflight reported `console_lock_state=unlocked` from `IOConsoleLocked`, then stopped because **Google Chrome was frontmost**. Final Cut was not frontmost; timeline visibility was not established. No headed runner, MCP publish preview, or import ran. The installed extension fingerprint and native target-binding readiness were not established in this preflight. No new disposable library path was selected or approved.

Earlier evidence records e38 runtime versus installed extension `1ebd32f262633cb719b0354ffd5e597397820944` as mismatched, with `artifactPublish=false`. That is historical; this preflight makes no current extension identity claim. The prior unrelated-project baseline is likewise historical and cannot substitute for a before/after comparison on this run.

## Acceptance status

| Requirement | Status |
| --- | --- |
| Exact persisted headless artifacts and source hashes available | Passed for historical e38 execution |
| Current candidate packed MCP and installed extension fingerprints aligned | Not tested |
| Current unrelated project and absent disposable target baseline | Not tested |
| Separately authorized exact publish preview | Not run |
| Separately authorized import once | Not run |
| Created library, project, sequence, semantic readback | Not tested |
| Source and unrelated-project after-state | Not tested |

To resume, pin one exact candidate and matching installed extension, bring Final Cut to a ready headed timeline, select and verify an absent disposable `.fcpbundle`, and record the unrelated project baseline. Then obtain separate authorization for that candidate's exact preview and subsequent import. Preserve one job through pending verification; report success only after matching native readback. Coordinate the exact-package Codex handoff with #541 and link the native result to #517.
