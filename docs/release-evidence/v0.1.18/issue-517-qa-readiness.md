# Issue #517 QA readiness

**Status: BLOCKED — production headless acceptance passed; native Final Cut Phase B and release-candidate validation remain unverified.**

## Validation target

- Milestone: #21, Release for v0.1.18.
- Current dependency head: PR #528 (issue #521), `5889b209860bd2ade69d67ea32876de86ce00d71`.
- Current source validation head: PR #528, `5889b209860bd2ade69d67ea32876de86ce00d71`; PR #531 adds QA evidence documentation on top of this code.
- PR #525's native handoff publisher is now at `1069769286483c9780caf44f7b27c5cf18bfd391`; its base branch also feeds stacked PR #526. This update makes a target-library publish wait for exact live project/sequence identity instead of accepting any nonempty live state.
- Native publisher support is present in PR #537, current commit `bb015588`; it stages the requested new library path and uses the read-only Final Cut library catalog for post-import target binding. The current head also requires live project/sequence IDs and names to match that binding before reporting success. This is implementation and deterministic-test evidence, not a real import result.
- The exact v0.1.18 release candidate is not available while the stacked dependency PRs remain open.
- Candidate headless acceptance ran against PR #526 code head `1b22d097`; the current rebased PR #526 head is `ca42b267`. The recorded run remains historical evidence, not a run at the current head or a release-candidate verdict.

## Passed

- The production Codex workflow completed against the candidate Framekit MCP. The user-approved preview digest was `88838e43e25076d8c2a130997705af4354ea82629094ce0c0d72c047bb2b3661`.
- Speech/VAD evidence covered B 5–13s, A 10–22s, and C 2–12s. The approved timeline was B 0–8s, A 8–20s, C 20–30s, with the `FrameKit MVP Test` title at 0–6s and locally generated music at 0–30s at −12 dB.
- Execution `rough-cut-60ad0f19-327c-4e23-aabd-dacd8af382f1` committed the isolated Framekit headless project revision `ir:de6153615fae9754ba3d9d0701b5e8ee5491f8ba2574f213de1bb6efd4fbcb0d`. The MP4 and FCPXML passed artifact verification and remained outside the repository. Source hashes, VAD intervals, render checks, and output hashes are recorded in [the #520 Codex acceptance report](issue-520-codex-video-acceptance.md).
- The consent-safe speech fixture specification and local generator are linked from that report. The actual acceptance run used locally synthesized speech, not human recordings or personal media.
- Full repository validation at PR #528 head `5889b209`: frozen install, build, 1,319 tests passed with 1 skipped, and package boundaries passed. The commit adds only sanitized clean-client evidence to the validated code at `67f5c0ff`; the pre-commit hook reran build, tests, and package boundaries on that staged tree.
- Native Xcode validation at code head `67f5c0ff`: Xcode 16.4 / macOS SDK 15.5 checks and `xcodebuild -list` passed. The evidence-only `5889b209` commit does not change native code. The project list emitted a missing DerivedData log-store warning but returned exit status 0 and listed all three schemes.
- The clean Codex 0.162.1 pre-tag smoke at code head `67f5c0ff` installed the plugin in a temporary Codex home, completed the deterministic in-memory headless workflow, and matched installed/source plugin digests (`a10eccfdebdb4a7ccbaff685ce3080858df22959cd0234d2963f2e13505fa0c0`). Its release-candidate verdict is `NO_GO`: the published npm package is still 0.1.17 at a different commit, the published MCP fingerprint lacks a full commit SHA, and signed native provenance is absent. Sanitized results are in [the 2026-10-19 15:52Z clean Codex evidence](issue-521-clean-mcp-codex-pretag-2026-10-19-1552Z.json).
- The #379 documented development workflow rebuilt and installed the extension from PR #537 checkout `bb015588`, then started a production MCP stdio session from that same checkout with headed native/canonical flags and validation commit pinned to `bb015588`. Read-only `connection.status` at `2026-10-19T15:40:51Z` reported `state=ready`, Final Cut detected, runtime and extension fingerprints both `0.1.17/bb015588cf5bca1bfcd29dba93f7b8389ff7c8b4`, and `buildAlignment.status: matched`. This satisfies local alignment for the #537 checkout; it does not align the distinct #528 candidate head `5889b209`. No native edit or import tool was called.
- Final Cut Pro 10.7.1's installed scripting definition exposes read-only library, event, project, and sequence identities. PR #537 uses that catalog for post-import binding; this confirms the supported identity source, not that the approved edit has been imported or read back.
- At PR #537 commit `bb015588`, the new library-bound publisher regression test passed for missing project/sequence state and mismatched live IDs or names. The publisher no longer reports success from a merely nonempty live-state response. Frozen install, build, all 1,292 tests (1 skipped), package boundaries, Xcode availability, and `xcodebuild -list` passed locally on this source content. This closes the code-level target identity gap; it does not establish native delivery or semantic timeline readback.
- PR #525 has the same fail-closed regression at `10697692`: frozen install, build, all 1,296 tests (1 skipped), package boundaries, Xcode availability, and `xcodebuild -list` passed locally. Hosted checks for this new head are pending; no native import or readback occurred.

## Not tested

- The initial read-only `connection.status` at `2026-10-19T15:24:36Z` reported mismatched extension/MCP commits (`0.1.17/a3731103` versus `0.1.17/dca3de31`) and `FINAL_CUT_CANONICAL_EXPORT_RECOVERY_REQUIRED`; no retry, edit, or import followed. The later #537 development run matched both fingerprints, but canonical reads/writes and new-project publishing remained unavailable in that candidate status. It did not test #528's distinct `5889b209` candidate or restore the failed canonical export.
- The approved FCPXML and MP4 are missing from `/tmp/framekit-acceptance-20261012/output-v2/`: `highlight.fcpxml` (SHA-256 `4b11a5b5f8349becd8bc07eaa6f16e74a59b2e2cbe812a38286b829ed24b7b5e`) and `highlight.mp4` (SHA-256 `0b0692c4bf07c73c5b94deac7a797af1f4ec6aa37d07526556d05179607e0f54`). The four source files are missing from `/tmp/framekit-codex-speech-fixture/`: `clip-a.mp4` (SHA-256 `e4702e13da203ff79e2de9ab9eb82145e531fbed334b3bfc7de2b8b6b68ee365`), `clip-b.mp4` (SHA-256 `6c197c9874ee44ed8a6cca1cefb1ec959e2f2f7211ec9d274503ea79c08b1d0d`), `clip-c.mp4` (SHA-256 `1f955e1e5ef2201013bc3b7e1691c7b9a4c67e87670bcbc9bd707ae1971c1fef`), and `generated-music.wav` (its expected digest is not in the checked-in acceptance report; the original `fixture-manifest.json` would provide it). The user does not know where a backup would be and believes there probably is none. A focused search of common home backup/sync folders and mounted volumes found no exact filenames. No new preview was created.
- Final Cut project import, created-target readback, timeline semantics, visual inspection, and native source/project immutability were not tested. No native mutation occurred; the separate import authorization has not been given.
- Audio loudness/noise, visual, and metadata analyzers were not configured. The fixture was checked for source identity and speech/VAD coverage, not subjective audio/video quality.
- The exact v0.1.18 release candidate and its release assets were not validated.

## Blockers and disposition

- Restore the exact approved FCPXML/media at their recorded paths if they become available; do not regenerate or reuse the approval for different paths or digests.
- Obtain separate authorization for the native import into a disposable library, then verify the actual created library/event/project/sequence and edit semantics through readback. The publisher/provider implementation is not native acceptance evidence.
- Validate the exact v0.1.18 release candidate after the dependency stack is available on the release branch.

Keep issue #517 open and this PR in draft. The headless production run passed, but this report does not claim QA PASS, native Phase B completion, release readiness, or issue closure.
