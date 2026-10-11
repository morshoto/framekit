# Issue #517 QA readiness

**Status: BLOCKED — readiness diagnostics only; the acceptance scenario has not run.**

## Validation target

- Milestone: #21, Release for v0.1.18
- Current dependency head: #521 at `7640e8490e9f972a0ddd9d1bb037b80e7ed2b41a`
- Release candidate: not available while the dependency PRs remain open
- Evidence collected: production Framekit MCP connection and route diagnostics

## Passed

- `connection.status` reached the configured Framekit MCP server. It reported the editor and extension as detected, but the live Final Cut socket was unavailable (`FINAL_CUT_HEADLESS_SOCKET_UNAVAILABLE`, `EPIPE`). The response states that this path does not launch or activate Final Cut Pro.
- `editing.route` for `timeline.edit` / `add-title` selected `headless`, reported no missing headless capabilities, and identified the Framekit project store as the canonical-write provider. It did not contact Final Cut.
- Existing implementation evidence is recorded in merged PR #518. Its production stdio test used generated A/B/C video and music fixtures; that fixture run is not evidence of an actual Codex-to-Final-Cut handoff.

## Prepared disposable source set

Four synthetic sources are prepared outside the repository. The video clips contain distinct colored geometric patterns and low-level source tones; the audio file is a generated three-tone chord. They are read-only and contain no user media.

| Asset | Duration | SHA-256 |
| --- | ---: | --- |
| `clip-a.mp4` | 24s | `e34a1940254431df54bc15b8e7e1ce5e02a46726382dd251d213995c53a83992` |
| `clip-b.mp4` | 15s | `7785563dbae6e563f789016c6520cda446e4c680d416d4a37f89a4835c603f66` |
| `clip-c.mp4` | 14s | `62e511b583002a3ef06056e5ad0a8aac22b9241abec505211c3016b78902ee1e` |
| `generated-music.wav` | 30s | `68028d0bcbf84a42701b38855ea9734cddbb296190819c6a93cfc1103907ee5d` |

The proposed canonical plan is the exact issue target: import A/B/C; place B source 5–13s at timeline 0–8s, A source 10–22s at 8–20s, and C source 2–12s at 20–30s; add editable `FrameKit MVP Test` title at 0–6s and independent generated music at 0–30s. This is a proposed plan, not an approved or executed edit.

## Not tested

- No Framekit project was created or changed, the prepared sources were not registered, and no MCP preview digest was generated.
- No timeline mutation was approved or executed; no MP4, FCPXML, or native project was produced for this acceptance run.
- The end-to-end workflow was not executed through Codex against production MCP.
- Final Cut Phase B import, target identity, timeline readback, visual inspection, focus behavior, and source/project immutability were not tested.
- Candidate package, MCP server, and Workflow Extension fingerprints are not available because the v0.1.18 release candidate does not exist yet.

## Blockers

- The exact release candidate and remaining dependency PRs are not yet available on `main`.
- The native connection returned `EPIPE`; its reported version is unknown and native writes are disabled.
- Creating the disposable Framekit project and registering these sources is pending authorization; the acceptance plan also requires approval of the exact preview before timeline mutation and separate authorization for any native Final Cut import or activation. None of those actions was performed during these readiness checks.

Keep issue #517 open. This report is not a PASS or FAIL verdict for the acceptance scenario. Continue with an isolated disposable project only after the target, media, and approval plan are ready, and perform Phase B only after separate authorization.
