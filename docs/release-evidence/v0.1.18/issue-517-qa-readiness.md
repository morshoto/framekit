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

## Not tested

- No Framekit project was created or changed, and no timeline mutation was previewed or executed.
- No real three-video and separate music source set was registered; no approval digest, MP4, FCPXML, or native project was produced for this acceptance run.
- The end-to-end workflow was not executed through Codex against production MCP.
- Final Cut Phase B import, target identity, timeline readback, visual inspection, focus behavior, and source/project immutability were not tested.
- Candidate package, MCP server, and Workflow Extension fingerprints are not available because the v0.1.18 release candidate does not exist yet.

## Blockers

- The exact release candidate and remaining dependency PRs are not yet available on `main`.
- The native connection returned `EPIPE`; its reported version is unknown and native writes are disabled.
- The acceptance plan requires separate human authorization for the exact timeline mutation and for any native Final Cut import or activation. Neither action was performed during these readiness checks.

Keep issue #517 open. This report is not a PASS or FAIL verdict for the acceptance scenario. Continue with an isolated disposable project only after the target, media, and approval plan are ready, and perform Phase B only after separate authorization.
