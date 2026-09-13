# Milestone 6 Codex goal prompt

This prompt is intended to be pasted into a new Codex session after the
`framekit-native` MCP server has been re-registered with the rebuilt package
artifact and the headed canonical provider. It is deliberately detailed: the
goal is to collect honest Milestone 6 evidence from the live MCP connection,
not to infer support from source code, documentation, fixtures, or a green
connection state.

## Goal

You are the verification agent for Framekit Milestone 6, `Release for
v0.1.7`. Verify the release goal against the actual headed Final Cut Pro
session currently connected through the `framekit-native` MCP server. The
milestone concerns analysis-driven editing workflows and basic compositing on
top of a trusted live editing substrate. The verification must determine what
is actually proven now, what is unavailable, and what remains blocked by the
local Final Cut environment.

The primary user scenario is to resolve the user-provided video directory,
import the intended video into the active Final Cut Browser, create a small
rough cut in a disposable Final Cut project, and add one visible animation or
overlay if the live capabilities support it. Do not export a movie. Keep the
final bounded rough cut in Final Cut only when the requested operations have
completed and have been verified.

The milestone verification also covers the boundaries around canonical live
editing, speech and filler removal, PIP, titles, masking, audio and visual
finishing, and asset discovery. These are separate capabilities. Verify each
one independently when its prerequisites are present; report it as unavailable
or not run when they are not. Never let a successful native title operation
stand in for proof of canonical timeline editing, and never let an analyzer
failure make unrelated native media or title operations appear unavailable.

## Operating mode and authority

Use only Framekit MCP tools exposed in this session. Do not use the terminal,
shell, filesystem APIs, browser automation, Computer Use, AppleScript, direct
Final Cut UI actions, direct FCPXML editing, screenshots as identity evidence,
or external rendering. Do not ask the user to run a fallback command while the
verification is in progress. The package rebuild and MCP registration were
performed before this session; use MCP responses to verify that the running
process is the intended one.

This is headed native verification. Final Cut Pro must be headed and frontmost
for native operations, and the active project must be disposable. If that
cannot be established, run the read-only preflight, report the safety blocker,
and stop before execute. Do not create a project through an undocumented UI
path or replace a production project.

The user's request authorizes only the bounded operations below on a disposable
target. It does not authorize changing an unidentified project, deleting
unrelated media, exporting, changing system settings, or using a fallback.
Before the first execute call, confirm the disposable project from MCP
identity; otherwise remain read-only.

The requested media location is a directory, not automatically a file. Use
the MCP directory workflow. Call
`editor.native.media.directory.preview` with the supplied directory, inspect
the returned supported files, and choose the intended file only if the result
contains the expected user-provided basename or another unambiguous file
explicitly identified by the user. Never guess a file from a directory path.
If the preview returns zero files, multiple plausible files without an
unambiguous target, an unavailable operation, or a structured path error, do
not use shell discovery or direct import as a workaround. Record the exact
blocker and stop the media-dependent part of the test.

## Non-negotiable safety rules

1. Begin with read-only calls. The required order is `connection.status`,
   `editor.inspect`, project discovery/inspection, and native inspection before
   any native mutation.
2. Treat `connection.status.state: "ready"` as proof only that a bridge
   answered. It does not prove headed mode, canonical reads, native writes,
   timeline placement, or Undo.
3. Read operation-level capability fields. For every relevant operation record
   `available`, `backend`, `guarantee`, and `unavailableReason` when present.
   A family-level flag is not enough when the operation has a more specific
   requirement.
4. Do not call an execute tool unless its matching preview succeeded, its
   preview token is single-use and unexpired, the target and revision still
   match, and the current project is disposable.
5. Preview calls must be demonstrably non-mutating. Inspect the relevant live
   state before and after a preview when the tool surface permits it.
6. Execute one bounded operation at a time. After each execute, read back the
   result using the most authoritative available MCP inspection tool, then use
   `edit.diff` and `edit.verify` when the operation is a canonical transaction.
7. Do not accept ambiguous media, duplicate occurrences, mutable names without
   stable identity, stale handles, stale revisions, guessed time ranges, or
   missing Accessibility identities.
8. If Final Cut is not frontmost, the timeline is not focused, Accessibility
   or Automation is unavailable, an overlay blocks the UI, or a menu/action
   cannot be verified, stop that operation and report the structured error.
   Bounded retry is allowed only when the MCP result explicitly says the
   operation may be retried safely; never retry blindly.
9. Do not export. Do not call `timeline.export`, do not create an output path,
   and do not treat a rendered file as evidence of a live timeline transaction.
10. Do not undo the final user-requested rough cut or final visible animation.
    Temporary capability probes must be undone before the final presentation
    edit is made. If an operation partially succeeds and its native Undo is
    safely available, use the operation-specific undo and verify restoration.
11. Keep evidence sanitized. Do not include credentials, raw snapshots, raw
    diagnostics, personal absolute paths, private media bytes, or unredacted
    transaction/operation identifiers in the final prose report. You may use
    exact identifiers internally to bind calls, but summarize them with stable
    redacted labels or short hashes.
12. Never fill an unavailable result with an empty fabricated snapshot, a
    guessed timeline, a placeholder asset, or a claim based on the source
    repository. An explicit unavailable result is a valid verification result.

## Phase 0: establish the live server and provenance

Call `connection.status` first. Record the response fields needed to classify
the session: state, detected editor, extension status, backend, process mode,
canonical timeline mode, last error, and any preflight information. The desired
headed setup should identify Final Cut Pro, a headed process mode, the native
canonical provider, and native writes enabled. If the response says
metadata-only, headless, unavailable, needs-user-action, waiting for a socket,
or another non-canonical mode, do not reinterpret it as success.

Call `editor.inspect` next. Read its package/version/build fingerprint,
provider identity, protocol information, process mode, document mode, and
capabilities. The fingerprint matters because an older package may produce a
plausible connection while omitting the provider. Report the returned
fingerprint and whether it is internally consistent. Do not claim a source
`main` match unless MCP provides that evidence.
If the fingerprint is missing, contradictory, or clearly describes the old
metadata-only process, stop and report a stale-session or provenance blocker;
do not compensate by calling lower-level native tools.

Confirm the registered tool surface and schemas. Use only present tools,
including project discovery, live/native inspection, native media and
title/PIP/mask workflows, canonical preview/execute, and diff/verify/undo. If a
tool is missing, report the contract gap instead of inventing an alias.

## Phase 1: identify and protect the target

Call `project.list` and inspect the catalog. Require stable project/sequence
IDs and an active relationship when canonical project capabilities are
advertised. Call `project.inspect`, `editor.live.inspect`, and
`editor.native.inspect`. Keep their roles separate: project inspection is
canonical snapshot evidence only when the provider advertises and returns it;
live inspection is active metadata/playhead evidence; native inspection is
UI/focus evidence.

Confirm that the project name or provider identity identifies the target as the
disposable verification project. Do not infer disposability from a generic
name, a recent modification time, or the fact that only one project is
visible. If the project is not explicitly safe, complete read-only capability
inspection and stop before import, append, title, PIP, mask, blade, delete, or
canonical execute. If the target is safe, record a redacted project label,
sequence label, stable IDs, current revision, playhead, selected range, and
current duration. Preserve rational frame time values as `value/timescale`;
do not convert them to approximate floating-point seconds.

If native focus is required, call `editor.native.focus` only after confirming
the target. It may activate Final Cut and focus the timeline but must not select
a different project or change content. Re-run `editor.native.inspect` and
require a verified frontmost window and timeline focus; otherwise mark
focus-dependent operations blocked.

## Phase 2: build the capability matrix

Before deciding what to edit, build an operation-level matrix from
`editor.inspect`. At minimum inspect these groups independently:

- canonical project catalog, project selection, complete timeline snapshot,
  canonical timeline write, read-after-write, and rollback;
- native timeline focus, media directory preview/import, Browser search and
  selection, timeline locate, append/insert, blade, range delete, and native
  Undo;
- native title discovery and title placement;
- native picture-in-picture placement;
- native transition discovery and placement;
- native mask placement, while distinguishing rectangle/Draw Mask from person
  cutout or tracking;
- speech analysis, VAD, filler-removal preview and execute;
- audio analysis, noise reduction, gain/fade or dialogue normalization;
- visual analysis and basic color-correction support;
- combined media understanding and Motion asset discovery.

For each row, write down the exact advertised backend and guarantee. A native
UI capability is not automatically a canonical timeline capability. The
headed canonical provider currently has a narrow canonical transaction
surface: if the capability payload says its supported canonical operation is
`rename-clip`, test only that operation through
`editor.timeline.edit.preview` and `editor.timeline.edit.execute`. Do not use
generic timeline media-add operations as a substitute for a missing canonical
provider operation. Native Browser import and native append can still be
tested separately when their own capabilities are available.

Call `editing.route` for the requested rough-cut/animation intent and for any
canonical edit intent that you plan to exercise. If route returns unavailable,
`selectedPath: "none"`, or a missing capability, respect it. Do not select an
external renderer unless the user explicitly requested that fallback; this
goal does not request one. If `editing.intent.resolve` is available, use it to
make the natural-language request explicit, but do not let a resolved intent
override operation-level capability or target safety.

## Phase 3: resolve and import the media through MCP

Call `editor.native.media.directory.preview` with the supplied media directory.
The preview is read-only and must return the supported top-level video files in
deterministic order. Confirm the intended basename from the returned result.
The expected input is the user-provided basename; if it is absent, do not
select another file merely because it has a similar name. If exactly one
supported file is returned and the user’s request unambiguously refers to it,
use that file.

Before directory execution, verify that the target project is disposable and
that bounded live mutation is authorized. Call
`editor.native.media.directory.execute` with the preview token and explicit
confirmation. This is a Browser import, not a timeline insertion. Record the
per-file status. A successful result must include a stable session media
handle, immutable Browser source identity, inferred media kind, and positive
verification that a newly appearing Browser result matched the imported source.

If import returns a timeout, pre-existing result, ambiguous result, identity
unavailable, UI unavailable, or partial status, preserve the exact stage and
error code. Do not report import as successful because Final Cut may have
accepted the command. If a partial import is possible, do not blindly repeat
the operation; inspect only through MCP and report whether the postcondition is
known. If directory preview/execute is unavailable but single-file import is
advertised, use the single-file tool only if the exact file path was returned
by the MCP directory preview and the schema supports the safe operation. Do not
use shell path expansion or a guessed filename.

After import, use `editor.native.media.select` with the returned handle and
verify the exact Browser identity. If the operation is unavailable, stop the
timeline portion. Do not replace the handle with a same-name search result.

## Phase 4: create and verify the rough cut

Use the selected Browser media to create the smallest useful rough cut. Prefer
`editor.native.media.append.preview` when adding the imported clip to the end
of the disposable sequence, or `editor.native.media.insert.preview` only when
the current playhead is an intentional insertion point. Confirm that the
preview identifies the same media handle, sequence, expected insertion time,
current duration, and current revision. If only the currently selected media
workflow is available, use its matching preview/execute pair and require a
stable AX identity.

The preview must not alter the sequence duration or revision. Execute exactly
one append or insert with its unexpired token. Verify that Final Cut reports
the expected media/occurrence, the sequence duration increased by the expected
rational amount, and the live revision advanced. Record the new occurrence
handle if returned. A native append with duration and revision readback proves
a headed native timeline insertion; it does not by itself prove a complete
canonical snapshot.

If a rough cut requires a cut, use `editor.native.blade.preview` at an observed
playhead or exact frame-aligned range. Do not choose a point by visual,
subtitle, or invented speech guess. Verify two segments and undo a temporary
probe before the final presentation edit. Use range deletion only with an exact
range and unchanged revision. Otherwise report assembly, not trim.

## Phase 5: add one visible animation or overlay

Select the smallest supported visual operation. Prefer a discovered native
title because it can be visibly checked without requiring a second source
clip. Call `editor.assets` with `kind: "title"` and inspect the discovery
provenance. Choose only a provider-qualified asset with a stable native identity
and `metadata.discovery` showing the native Final Cut source. Filesystem Motion
assets are useful discovery evidence but are not proof that the built-in Titles
browser can place the asset. If native discovery is unavailable or empty, mark
title placement unavailable and consider PIP or transition only when their own
capabilities and targets are verified.

Call `editor.native.title.add.preview` with the discovered asset ID, explicit
text, and a positive frame-aligned duration. Place it at the current verified
playhead or an explicit in-bounds rational range. Confirm the preview target,
sequence, range, asset identity, and revision; then execute with the short-lived
token. Verify selected-title identity, visible placement metadata, changed
revision, and native Undo availability. If this is a temporary capability
probe, undo it and verify restoration. After all temporary probes, add one
final small title as the requested visible animation and leave that final title
in the disposable rough cut. Do not claim keyframes or custom animation unless
the tool response explicitly exposes and verifies those properties.

If native title discovery is unavailable but PIP is available, use
`editor.native.picture-in-picture.preview` only with one selected Browser video,
one stable timeline occurrence, an unchanged revision, and explicit transform
properties accepted by the current schema. Verify the connected clip,
position, scale, crop/frame values if returned, Inspector readback, revision,
and native Undo. A PIP probe should be undone before the final title unless PIP
is the chosen final visible animation. Do not infer PIP from a connected clip
handle without Inspector or post-command readback.

For transitions, call `editor.native.transition.search` and use only a stable
result. Locate both adjacent occurrences through MCP, require an exact shared
sequence and frame-aligned boundary, then preview and execute the smallest
supported duration. Verify selection, observed duration, revision, and Undo.
One clip is not enough; missing browser search, adjacency, or identity is
discovery/targeting unavailable.

## Phase 6: verify canonical live editing separately

If and only if the capability matrix advertises canonical-write with project
catalog, complete snapshot, read-after-write, and rollback, test the provider’s
supported canonical transaction. Re-inspect the project after the native rough
cut because native insertion may have changed the revision. Obtain the exact
project ID, sequence ID, current base revision, and a complete canonical
snapshot. Require valid media and occurrence identities, rational coordinates,
storyline relationships, and an active catalog entry.

Use the provider-supported `rename-clip` operation only when the target
occurrence is unique and its identity is stable. Call
`editor.timeline.edit.preview` with explicit project ID, sequence ID, base
revision, and the exact operation. Confirm the preview is non-mutating and
that its expected diff changes only the requested clip name. Execute once with
the single-use token. The result must include the matching target, an
advancing canonical revision, a read-after-write snapshot, a deterministic
diff, verification success, and an Undo transaction reference.

Call the appropriate diff and verification tools to cross-check the response.
Then call `edit.undo` using the returned transaction reference and inspect the
same project/sequence again. The clip name and canonical digest must be
restored even if the restoration receives a new revision. If any readback,
diff, verification, or restoration step fails, report canonical verification
as failed or blocked; do not downgrade the result to “probably worked.”

If canonical project or timeline capability is unavailable, do not attempt
`editor.timeline.edit`, generic filler removal, or canonical masking. This is
an expected limitation for a metadata-only provider and is independent of
successful native Browser or title operations. Do not use the native live
metadata response as a fabricated canonical snapshot.

## Phase 7: verify analysis and filler boundaries

Speech is an editor-independent analysis layer. Call `speech.analyze` only when
the MCP capability reports a configured provider and the selected media/range
can be bound to an exact identity. The result must distinguish word-level
timestamps, confidence, speech/VAD evidence, and unavailable modalities. Do
not interpret “Speech analysis unavailable on this machine” as a Final Cut
editing defect; report the analyzer backend as unconfigured or unavailable.

Attempt `speech.filler.remove.preview` only when speech analysis, VAD or the
required silence evidence, canonical timeline snapshot, canonical write,
read-after-write, and rollback are all available. Use a selected canonical
range and require revision-bound safe ranges. Protected speech must remain
protected. If the preview returns no safe candidates, treat that as a valid
no-op result and do not invent a filler range.

If execution is authorized and the preview is valid, execute once, verify the
resulting diff and adjacent re-analysis, then use `edit.undo` and verify the
original canonical digest. If any required speech or canonical capability is
missing, do not call execute. Record `speech unavailable`, `filler not run`,
and the exact missing prerequisite. Native rough-cut success cannot be used as
filler-removal proof.

## Phase 8: verify independent finishing and asset surfaces

Inspect audio, visual, metadata, and combined understanding separately. If an
analyzer returns real evidence, record provider, media identity, range, and
confidence; if absent, retain unavailable. Never synthesize loudness, noise,
scene, mood, or usable range from a filename or screenshot.

For Motion assets, call `editor.assets` for titles and transitions when useful.
Keep filesystem and native provenance separate: filesystem-only discovery never
proves native placement, which belongs in the headed-native tier.

Test noise reduction, dialogue normalization, gain/fade, or color correction
only when the schema advertises the exact operation with preview, execute,
readback, diff/verify, and rollback. Use one minimal disposable probe, restore
it before the final rough cut, and do not treat fixture support as native proof.

## Failure and recovery policy

Use the structured MCP error as truth. Preserve operation, stage, code, and a
sanitized message. Distinguish stale/fingerprint, metadata-only/headless,
unsafe target, Browser/import, ambiguity, unavailable title/PIP/mask or
analyzer, stale revision, and failed native Undo.

A failure before execute means no mutation should be assumed; verify this with
the relevant read-only inspection when possible. A failure after execute is a
partial mutation until the tool proves otherwise. Use the returned operation
or transaction handle only through the corresponding MCP Undo contract. Never
run a second edit to “repair” an uncertain first edit. If restoration cannot
be proven, stop, report the uncertainty, and do not continue to another
mutation.

Do not classify an expected unavailable capability as a product failure when
the provider correctly advertises its boundary and returns a structured
unavailable result. Do classify silent success, empty fabricated snapshots,
generic errors without stage information, revision mismatches accepted by the
adapter, or a write reported without read-after-write as verification failures.

## Final report contract

At the end, write a concise Japanese report. Keep detailed evidence in MCP
context but redact sensitive values from the report.

1. 結論: `PASS`, `PASS WITH LIMITATIONS`, or `FAIL`.
2. 実行コンテキスト: MCP server identity/fingerprint, protocol, Final Cut
   version if returned, headed/headless mode, backend, canonical mode, target
   class, and whether mutation occurred.
3. Capability matrix: operation, available, backend, guarantee,
   unavailableReason, and evidence tier.
4. Test results: case ID, MCP tools used, intended postcondition, observed
   result, and `PASS`, `FAIL`, `BLOCKED`, `EXPECTED UNAVAILABLE`, or `NOT RUN`.
5. Native rough-cut evidence: imported basename, Browser source identity
   class, occurrence identity class, sequence, duration change, revision
   change, animation/overlay type, and final state. Do not include the private
   absolute media path.
6. Canonical transaction evidence: target, base/result revision, intended diff,
   read-after-write, verification, Undo, restoration, or why it was not run.
7. Analysis and asset evidence: speech/VAD, filler, audio, visual, titles,
   transitions, PIP, and masking as independent rows. State explicitly that
   person cutout/tracking is not proven by a generic mask operation.
8. Evidence boundary: separate deterministic fixture, FCPXML artifact,
   metadata-only live, canonical live, and headed-native proof. Never promote
   one tier into another.
9. Blockers and not-run work: structured errors, missing permissions/providers,
   ambiguous targets, or lack of a disposable project.
10. Release decision: state only the Milestone 6 exit criteria actually proven
    by this run. Do not say “Final Cut editing works” unless the specific
    headed operation has post-command readback, revision evidence, and native
    Undo or the appropriate canonical restoration evidence.

Finish with one line containing counts for total cases, PASS, FAIL, BLOCKED,
EXPECTED UNAVAILABLE, and NOT RUN, followed by the smallest next action. State
clearly that no export was performed. Leave the final verified rough cut and
chosen visible animation in the disposable Final Cut project only if they were
the requested final operations; temporary probes must already be restored.

Do not create GitHub issues, pull requests, commits, release artifacts, or
documentation changes; this session is only for live MCP verification.
