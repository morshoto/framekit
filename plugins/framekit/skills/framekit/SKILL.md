---
name: framekit
description: Produce reviewable videos from local media through Framekit, or inspect Final Cut Pro with explicit capability and native-edit safety boundaries.
---

# Framekit Video Production and Final Cut

Use this skill for a video or rough-cut request using local media, or when the
user asks to inspect or work with Final Cut Pro through Framekit MCP. For the
repeatable production run, follow the [Codex video production runbook](../../references/tests/codex-video-production-e2e.md).

## Headless video production

The plugin starts Framekit with `--headless`. Call `connection.status` to report
live Final Cut readiness, but a non-ready connection does not block a
Framekit-owned headless project. Continue through headless tools; do not invent
live project state or silently switch to UI automation.

1. Use a named Framekit project. Open the project the user selected, or create
   one with a valid empty Timeline IR when they requested a new project. Do not
   repurpose another project without their direction.
2. Register each user-selected local source with `headless.media.register`,
   carrying forward the exact returned project revision as `expectedRevision`.
   Keep the returned resource IDs and source digests.
3. Call `media.understand` for each resource with both `projectId` and `mediaId`.
   Report analyzed and unavailable capabilities separately. Use only returned
   transcript, VAD, loudness, and source identity evidence.
4. Call `rough-cut.plan` with `projectId` and the user's editorial query. Review
   each proposed source, range, confidence, rationale, and evidence. Ask for
   clarification when the plan has no supported shots or misses the user's
  intent. The planner matches individual query terms and ranks supported
  speech ranges by term hits; include terms for each intended source, then
  confirm every intended source appears in the result. Follow the user's
  requested source order, ranges, title, music, and audio policy. Reorder
  returned shots only when requested, preserving their source identities,
  ranges, and evidence. Do not create speech/VAD evidence or unsupported shot
  ranges. Get approval for the exact plan before execution.
5. Call `headless.rough-cut.preview` with that plan and explicit output paths.
   Put requested title and music edits in its `operations`, and set
   `sourceAudioPolicy: "preserve-and-mix"` when requested. Review its plan
   digest, final timeline, source audio policy, render and FCPXML output intent,
   provenance, and verification requirements with the user. Get approval for
   the exact preview and output settings before executing. Execute only the
   unchanged approved plan, operations, and settings.
6. Call `headless.rough-cut.execute` with the returned digest and
   `approved: true`. Report completion only when it confirms a verified MP4
   and FCPXML. Keep the `executionId`, exact artifact path and digest, source
   revision, and canonical revision for a possible later handoff.

Headless analysis revalidates local media and binds results to source identity
and project revision. `CAPABILITY_UNAVAILABLE` or an unavailable analyzer is a
real limitation; do not fill in missing analysis. Headless rendering and
FCPXML generation do not contact Final Cut.

## Optional native handoff (experimental; not guaranteed in v0.1.18)

The plugin's server cannot import into Final Cut because it starts with native
writes disabled. The separate native publishing path is experimental and is
not a v0.1.18 release guarantee. A native handoff requires a separately
configured headed Framekit server, a ready Final Cut session, and
`artifactPublish` capability. A non-activating document-open acknowledgment
means only that dispatch was accepted; do not claim a native project was
created unless the same job reaches `verified` with matching created-target
readback. Follow the native setup in the runbook. If readiness or capability is
missing, report the specific blocker and keep the verified local artifacts
available.

Call `artifact.publish.preview` with the exact FCPXML `artifactPath`,
`headlessExecutionId`, and a new absolute `.fcpbundle` `targetLibraryPath`
whose parent directory exists. Show the user its source proof, artifact digest,
target project/sequence, and new library path. Require explicit user authorization for that
import before calling `artifact.publish.execute` with the returned `jobId` and
`confirm: true`. Inspect the same job with `artifact.publish.status`. For a
`verification-pending` job, obtain separate user authorization for headed
semantic readback of that exact job, target, and artifact digest before calling
`artifact.publish.execute` again with `confirm: true` and
`confirmVerification: true`.

If the job is `awaiting-final-cut`, report that it is pending and wait until the
user makes Final Cut ready; inspect the same job before retrying it. If the job
is `verification-pending`, request the separate readback authorization above
and never create a second import job. Claim successful delivery only when status is `verified`
and includes matching target readback. Never infer an import from a queued,
pending, dispatched, or unverifiable result.

## Live Final Cut inspection

1. Call `connection.status` before relying on the bridge.
2. Call `editor.live.inspect` to read the current project, sequence, playhead,
   revision, and advertised capabilities.
3. Treat missing Final Cut Pro, Workflow Extension, or socket as an actionable
   prerequisite error. Accessibility and Automation permissions are required
   only for an explicit headed native-write setup; they are not prerequisites
   for headless read-only access.
4. Treat `CAPABILITY_UNAVAILABLE` as a hard boundary for the active backend.
   Do not invent timeline snapshots, media results, or edit success.

Live metadata availability does not prove canonical timeline snapshot or write
access. Inspect capability flags before selecting a tool. For a deliberate
headed native edit, retain the existing preview, execute, frontmost, focus,
verification, and undo workflow. Ask the user to complete missing Workflow
Extension setup; do not broaden filesystem or application access on their
behalf.
