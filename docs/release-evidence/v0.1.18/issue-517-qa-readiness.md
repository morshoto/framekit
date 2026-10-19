# Issue #517 QA readiness

**Status: BLOCKED — production headless acceptance passed; native Final Cut Phase B and release-candidate alignment remain unverified.**

## Validation target

- Milestone: #21, Release for v0.1.18.
- Current dependency head: PR #528 (issue #521), `a292a51f`.
- The exact v0.1.18 release candidate is not available while the stacked dependency PRs remain open.
- Candidate headless acceptance ran against PR #526 code head `1b22d097`; it is implementation evidence, not a release-candidate verdict.

## Passed

- The production Codex workflow completed against the candidate Framekit MCP. The user-approved preview digest was `88838e43e25076d8c2a130997705af4354ea82629094ce0c0d72c047bb2b3661`.
- Speech/VAD evidence covered B 5–13s, A 10–22s, and C 2–12s. The approved timeline was B 0–8s, A 8–20s, C 20–30s, with the `FrameKit MVP Test` title at 0–6s and locally generated music at 0–30s at −12 dB.
- Execution `rough-cut-60ad0f19-327c-4e23-aabd-dacd8af382f1` committed the isolated Framekit headless project revision `ir:de6153615fae9754ba3d9d0701b5e8ee5491f8ba2574f213de1bb6efd4fbcb0d`. The MP4 and FCPXML passed artifact verification and remained outside the repository. Source hashes, VAD intervals, render checks, and output hashes are recorded in [the #520 Codex acceptance report](issue-520-codex-video-acceptance.md).
- The consent-safe speech fixture specification and local generator are linked from that report. The actual acceptance run used locally synthesized speech, not human recordings or personal media.
- Read-only headed preflight detected Final Cut Pro and the installed Workflow Extension. No native write or import tool was called.

## Not tested

- The publisher reports `artifactPublish=false` and `timelinePublishNewProject=false`; production has no target-binding provider. The FCPXML target UIDs are proposed identifiers, not native reservations or verified Final Cut identities.
- Final Cut project import, native target identity, timeline readback, visual inspection, and native source/project immutability were not tested. No native mutation occurred.
- The Workflow Extension fingerprint was unavailable, so candidate/build alignment could not be confirmed.
- Audio loudness/noise, visual, and metadata analyzers were not configured. The fixture was checked for source identity and speech/VAD coverage, not subjective audio/video quality.
- The exact v0.1.18 release candidate and its release assets were not validated.

## Blockers and disposition

- Provide a production target-binding provider that returns the actual newly created Final Cut project/sequence identity and supports matching readback.
- Provide a candidate-matched Workflow Extension fingerprint and rerun headed native acceptance only when the publisher can bind its target safely.
- Validate the exact v0.1.18 release candidate after the dependency stack is available on the release branch.

Keep issue #517 open and this PR in draft. The headless production run passed, but this report does not claim QA PASS, native Phase B completion, release readiness, or issue closure.
