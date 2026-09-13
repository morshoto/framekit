# Background Final Cut Render and Export Investigation

Issue: [#262](https://github.com/morshoto/framekit/issues/262)<br>
Status: Decision recorded (read-only investigation plus deterministic provider contract)<br>
Last verified: 2026-09-13<br>
Target: Final Cut Pro 10.7.1 (build 410082)<br>
Evidence tier: Apple documentation plus installed Final Cut surface inspection

## Decision

No supported background-native Final Cut render or export provider is available
for the inspected Final Cut Pro version. Framekit must keep `timeline.export` as
an explicit headed-native workflow with frontmost and timeline-focus preflight.
It must not remove the guard, invoke undocumented render services, or label an
external render as Final Cut-native output.

Framekit may run an explicitly configured external renderer against an explicit
FCPXML artifact in the background. That provider is available only when its
renderer and metadata verifier are configured. Its result is marked
`renderer: "external-renderer"` with an `artifact-rendered` or
`external-rendered` evidence tier, never `background-native`.

## Current-version evidence

The installed Final Cut Pro application reports version `10.7.1` and build
`410082`. Its app-specific Apple Event dictionary exposes the read-only
`com.apple.FinalCut.library.inspection` access group and a `get` command, but no
documented render, export-job, cancellation, progress, or output-commit command.
The checked-in Workflow Extension bridge exposes live metadata and change
observation, not a render service.

Apple's [background rendering guide](https://support.apple.com/guide/final-cut-pro/ver717f3ca3/mac)
describes temporary video and audio render files used to improve playback after
the user stops working. It does not define a supported external job API for
Framekit to submit, monitor, cancel, verify, and commit a delivery file.

Apple's [FCPXML reference](https://developer.apple.com/documentation/professional-video-applications/fcpxml-reference)
defines an interchange format for media, projects, editing decisions, and
metadata. FCPXML is a source artifact, not proof that a separate renderer can
reproduce Final Cut effects, titles, transitions, color behavior, or plugins.

## Provider decision matrix

| Candidate | Disposition | Boundary |
| --- | --- | --- |
| Final Cut background rendering | **unavailable** as a Framekit provider | Playback render files are internal temporary state; no target-bound delivery job, progress, cancellation, or verified output API was established. |
| Current Final Cut Apple Events | **headed-only** for delivery export | The installed dictionary has read-only library inspection and `get`, not a render/export command or output transaction. |
| Workflow Extension | **unavailable** for background-native rendering | The public host surface exposes metadata, timing, playhead, and changes, not a render service. |
| Managed FCPXML artifact | **background-capable** as an explicit source | Framekit can bind, edit, verify, and publish the artifact; an output rendered from it remains artifact evidence and does not change the open timeline. |
| External renderer | **background-capable** when explicitly configured | The renderer must accept the bound source, report progress, honor cancellation, and return to Framekit for metadata verification and atomic commit. Its output is external-rendered evidence. |

An external renderer is a separate capability. It is never an implicit fallback
for a connected Final Cut editor, must not be presented as native, and never
upgrades an artifact-rendered result to native Final Cut evidence.

## Background provider contract

The provider contract is deliberately independent of Final Cut UI automation.
Each request must include:

1. **Source target** — the source kind, immutable project ID, and sequence ID.
   An FCPXML source also includes its exact artifact path.
2. **Revision/digest binding** — at least one source revision or digest; a
   transaction-backed workflow should provide both so the source cannot drift
   silently.
3. **Preset and output-path validation** — non-empty preset, writable parent
   directory, normalized output path, and explicit overwrite confirmation.
4. **Bounded lifecycle** — `queued` → `rendering` → `verifying` → `completed`,
   with `cancelled` and `failed` terminal states and a finite timeout.
5. **Progress and cancellation** — renderer progress is observable; cancellation
   aborts the job and must not continue into verification or commit.
6. **Atomic staging and commit** — render into a unique staging path in the
   destination directory. Commit with an atomic rename only after verification;
   remove staging on cancellation or failure and preserve an existing output.
7. **Output verification** — require non-empty output, ffprobe or equivalent
   media metadata, a content digest, and valid duration, dimensions, frame rate,
   and audio-stream evidence before reporting completion.
8. **Provenance** — return the renderer identity, evidence tier, source binding,
   preset, output path, metadata, and digest. An unverified output must not be reported as complete.

The deterministic `BackgroundRenderExportProvider` implements this lifecycle
for an injected external renderer and probe. It rejects `final-cut-timeline`
sources until a separately proven background-native provider exists. This is a
contract and safety boundary, not a claim that an external renderer reproduces
Final Cut semantics.

## Existing headed export boundary

`timeline.export` remains the existing headed-native path. It uses Final Cut's
Share menu, requires native writes, frontmost Final Cut, timeline focus, and
`ffprobe`, and preserves its existing overwrite and transaction verification
guards. Its capability is `families.export.timeline` with the
`headed-native` evidence tier.

The new `families.export.background` and `families.export.external` descriptors
are additive. The current artifact-backed provider reports backend
`external-renderer` and `evidenceTier: "artifact-rendered"`; the separate
external-rendered capability remains unavailable until a supported source can
provide that evidence. It does not alter the headed `timeline.export` route.

## Reopening the decision

Reconsider background-native rendering only after a disposable-project proof
records the Final Cut version, explicit target, source revision/digest, progress,
cancellation, bounded failure behavior, verified media metadata, atomic output,
and renderer provenance without bringing Final Cut to the foreground.

Undocumented `.fcpbundle` internals, private render databases, and guessed
equivalence are not acceptable evidence for reopening this decision.
