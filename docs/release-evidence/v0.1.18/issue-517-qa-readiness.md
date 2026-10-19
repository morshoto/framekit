# Issue #517 QA readiness

**Status: BLOCKED — production headless acceptance passed; native Final Cut Phase B and release-candidate validation remain unverified.**

## Validation target

- Milestone: #21, Release for v0.1.18.
- Current dependency head: PR #528 (issue #521), `305acc4bbe2fc6b3161f7a177066d35991a26e6d`.
- Current source validation head: PR #528, `305acc4bbe2fc6b3161f7a177066d35991a26e6d`; PR #531 adds QA evidence documentation on top of this code.
- Native publisher support is present in PR #537, commit `026e12a03d852eaf3d6e65d04935348808732918`; it stages the requested new library path and uses the read-only Final Cut library catalog for post-import target binding. This is implementation and deterministic-test evidence, not a real import result.
- The exact v0.1.18 release candidate is not available while the stacked dependency PRs remain open.
- Candidate headless acceptance ran against PR #526 code head `1b22d097`; it is implementation evidence, not a release-candidate verdict.

## Passed

- The production Codex workflow completed against the candidate Framekit MCP. The user-approved preview digest was `88838e43e25076d8c2a130997705af4354ea82629094ce0c0d72c047bb2b3661`.
- Speech/VAD evidence covered B 5–13s, A 10–22s, and C 2–12s. The approved timeline was B 0–8s, A 8–20s, C 20–30s, with the `FrameKit MVP Test` title at 0–6s and locally generated music at 0–30s at −12 dB.
- Execution `rough-cut-60ad0f19-327c-4e23-aabd-dacd8af382f1` committed the isolated Framekit headless project revision `ir:de6153615fae9754ba3d9d0701b5e8ee5491f8ba2574f213de1bb6efd4fbcb0d`. The MP4 and FCPXML passed artifact verification and remained outside the repository. Source hashes, VAD intervals, render checks, and output hashes are recorded in [the #520 Codex acceptance report](issue-520-codex-video-acceptance.md).
- The consent-safe speech fixture specification and local generator are linked from that report. The actual acceptance run used locally synthesized speech, not human recordings or personal media.
- Full repository validation at `305acc4b`: build and package boundaries passed; 1,318 tests passed, 1 skipped. Frozen install passed immediately before the commit on the same source content; the exact pushed head was revalidated with install skipped. The locale-independent Codex plugin digest fix and regression test are included.
- Native Xcode validation at `851f1fc8`: Xcode 16.4 / macOS SDK 15.5 checks and `xcodebuild -list` passed. The later source change only updates JavaScript digest ordering and its test; native validation was not rerun.
- The #379 development workflow installed an extension from source head `a3731103`. A local production MCP stdio session at that same head reported `ready`, ran in headless mode, exposed matching runtime and extension fingerprints (`0.1.17`, commit `a3731103`), and reported `buildAlignment.status: matched`. MCP discovery returned 127 tools; read-only `project.list` returned 9 projects. Since then, the integrated source head has advanced through publisher regression coverage and the locale-independent Codex plugin digest implementation and test, alongside QA and release evidence updates. The installed extension has not been rebuilt for `305acc4b`, so exact current-commit alignment remains unverified. No native edit or import tool was called.
- Final Cut Pro 10.7.1's installed scripting definition exposes read-only library, event, project, and sequence identities. PR #537 uses that catalog for post-import binding; this confirms the supported identity source, not that the approved edit has been imported or read back.

## Not tested

- The separately registered Framekit MCP connector still reports its older extension commit `dca3de31a57a77c3a019023ebd13e7924f943ccb`, `artifactPublish=false`, `timelinePublishNewProject=false`, and no canonical project reads. It does not represent the locally validated `a3731103` checkout.
- The approved FCPXML and MP4 are missing from `/tmp/framekit-acceptance-20261012/output-v2/`: `highlight.fcpxml` (SHA-256 `4b11a5b5f8349becd8bc07eaa6f16e74a59b2e2cbe812a38286b829ed24b7b5e`) and `highlight.mp4` (SHA-256 `0b0692c4bf07c73c5b94deac7a797af1f4ec6aa37d07526556d05179607e0f54`). The four source files are missing from `/tmp/framekit-codex-speech-fixture/`: `clip-a.mp4` (SHA-256 `e4702e13da203ff79e2de9ab9eb82145e531fbed334b3bfc7de2b8b6b68ee365`), `clip-b.mp4` (SHA-256 `6c197c9874ee44ed8a6cca1cefb1ec959e2f2f7211ec9d274503ea79c08b1d0d`), `clip-c.mp4` (SHA-256 `1f955e1e5ef2201013bc3b7e1691c7b9a4c67e87670bcbc9bd707ae1971c1fef`), and `generated-music.wav` (its expected digest is not in the checked-in acceptance report; the original `fixture-manifest.json` would provide it). The user does not know where a backup would be and believes there probably is none. A focused search of common home backup/sync folders and mounted volumes found no exact filenames. No new preview was created.
- Final Cut project import, created-target readback, timeline semantics, visual inspection, and native source/project immutability were not tested. No native mutation occurred; the separate import authorization has not been given.
- Audio loudness/noise, visual, and metadata analyzers were not configured. The fixture was checked for source identity and speech/VAD coverage, not subjective audio/video quality.
- The exact v0.1.18 release candidate and its release assets were not validated.

## Blockers and disposition

- Restore the exact approved FCPXML/media at their recorded paths if they become available; do not regenerate or reuse the approval for different paths or digests.
- Obtain separate authorization for the native import into a disposable library, then verify the actual created library/event/project/sequence and edit semantics through readback. The publisher/provider implementation is not native acceptance evidence.
- Validate the exact v0.1.18 release candidate after the dependency stack is available on the release branch.

Keep issue #517 open and this PR in draft. The headless production run passed, but this report does not claim QA PASS, native Phase B completion, release readiness, or issue closure.
