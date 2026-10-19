# Issue #517 QA readiness

**Status: BLOCKED — production headless acceptance passed; native Final Cut Phase B and release-candidate validation remain unverified.**

## Validation target

- Milestone: #21, Release for v0.1.18.
- Current dependency head: PR #528 (issue #521), `83d565c6`.
- Integrated QA head: PR #531, `a3731103b639022b837f191b651cb46b50a2f2e5`.
- Native publisher support is present in PR #537, commit `f77d158cef611c029be904eaa02ff830338a76fd`; it stages the requested new library path and uses the read-only Final Cut library catalog for post-import target binding.
- The exact v0.1.18 release candidate is not available while the stacked dependency PRs remain open.
- Candidate headless acceptance ran against PR #526 code head `1b22d097`; it is implementation evidence, not a release-candidate verdict.

## Passed

- The production Codex workflow completed against the candidate Framekit MCP. The user-approved preview digest was `88838e43e25076d8c2a130997705af4354ea82629094ce0c0d72c047bb2b3661`.
- Speech/VAD evidence covered B 5–13s, A 10–22s, and C 2–12s. The approved timeline was B 0–8s, A 8–20s, C 20–30s, with the `FrameKit MVP Test` title at 0–6s and locally generated music at 0–30s at −12 dB.
- Execution `rough-cut-60ad0f19-327c-4e23-aabd-dacd8af382f1` committed the isolated Framekit headless project revision `ir:de6153615fae9754ba3d9d0701b5e8ee5491f8ba2574f213de1bb6efd4fbcb0d`. The MP4 and FCPXML passed artifact verification and remained outside the repository. Source hashes, VAD intervals, render checks, and output hashes are recorded in [the #520 Codex acceptance report](issue-520-codex-video-acceptance.md).
- The consent-safe speech fixture specification and local generator are linked from that report. The actual acceptance run used locally synthesized speech, not human recordings or personal media.
- Current integrated validation at `a3731103`: frozen install and build passed; 1,317 tests passed, 1 skipped; package boundaries passed; Xcode 16.4 / macOS SDK 15.5 checks and `xcodebuild -list` passed.
- The #379 development workflow installed an extension built from the integrated checkout. A local production MCP stdio session reported `ready`, ran in headless mode, exposed matching runtime and extension fingerprints (`0.1.17`, commit `a3731103`), and reported `buildAlignment.status: matched`. MCP discovery returned 127 tools; read-only `project.list` returned 9 projects. No project names were recorded, and no native edit or import tool was called.
- Final Cut Pro 10.7.1's installed scripting definition exposes read-only library, event, project, and sequence identities. PR #537 uses that catalog for post-import binding; this confirms the supported identity source, not that the approved edit has been imported or read back.

## Not tested

- The separately registered Framekit MCP connector still reports its older extension commit `dca3de31a57a77c3a019023ebd13e7924f943ccb`, `artifactPublish=false`, `timelinePublishNewProject=false`, and no canonical project reads. It does not represent the locally validated `a3731103` checkout.
- The approved FCPXML, approved MP4, and four source media files are missing from their recorded `/tmp` paths. The user reports no known backup and has chosen not to regenerate them. No new preview was created.
- Final Cut project import, created-target readback, timeline semantics, visual inspection, and native source/project immutability were not tested. No native mutation occurred; the separate import authorization has not been given.
- Audio loudness/noise, visual, and metadata analyzers were not configured. The fixture was checked for source identity and speech/VAD coverage, not subjective audio/video quality.
- The exact v0.1.18 release candidate and its release assets were not validated.

## Blockers and disposition

- Restore the exact approved FCPXML/media at their recorded paths if they become available; do not regenerate or reuse the approval for different paths or digests.
- Obtain separate authorization for the native import into a disposable library, then verify the actual created library/event/project/sequence and edit semantics through readback. The publisher/provider implementation is not native acceptance evidence.
- Validate the exact v0.1.18 release candidate after the dependency stack is available on the release branch.

Keep issue #517 open and this PR in draft. The headless production run passed, but this report does not claim QA PASS, native Phase B completion, release readiness, or issue closure.
