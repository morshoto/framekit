# Milestone 6 headed MCP preflight

Date: 2026-09-13
Scope: read-only provenance and capability preflight for the v0.1.7 headed
Final Cut Pro session
Evidence tier: canonical-live preflight plus headed-native preflight
Result: blocked before mutation

## What the running MCP process proved

The live `framekit-native` MCP process reported:

- editor: Final Cut Pro;
- backend: `final-cut-native-canonical`;
- Framekit fingerprint: version `0.1.7`, commit `1cb1c28`;
- process mode: `headed`;
- document mode: `canonical-live`;
- preflight mode: `native-write`;
- canonical project read/write, read-after-write, incremental changes, and
  rollback advertised as available;
- native Accessibility capabilities advertised for media import/selection,
  append/insert, title and transition discovery/placement, bounded masking,
  timeline focus, and Undo.

The MCP surface does not echo raw environment variables. The effective
`backend`, `documentMode`, and version fingerprint are consistent with the
requested native canonical provider and are sufficient to distinguish this
process from a metadata-only or stale artifact process. This is not proof that
any operation changed Final Cut Pro.

## Operation-level matrix

| Operation | Advertised capability | Evidence in this run | Status |
| --- | --- | --- | --- |
| Connection | headed native canonical | `connection.status` and `editor.inspect` | pass: preflight only |
| Canonical project read/write | canonical-live | capability payload only; project read failed before snapshot | blocked |
| Native focus | native-verified | Final Cut was frontmost, but timeline focus failed | blocked |
| Browser media import | native-verified | no directory preview was called | not run |
| Rough-cut append/insert | native-verified | no target or preview token | not run |
| Native title/PIP/transition | operation payload varied by surface; no canonical composite title/PIP/mask guarantee | no discovery or placement | not run |
| Masking | bounded native masking advertised; person cutout unavailable | no target or preview | not run |
| Speech/VAD/filler | speech transcription, VAD, and audio analysis unavailable | no analysis or filler preview | unavailable / not run |
| Export | export capability advertised | export explicitly forbidden by the goal | not run |

## Blocker and stop point

`project.list` and `project.inspect` could not obtain the canonical snapshot.
The bridge's Final Cut XML automation failed because the Export XML window was
not exposed. `editor.live.inspect` still returned the active verification
project label and revision, but that metadata is not a substitute for a
canonical project catalog or complete timeline snapshot.

The native inspection first reported Final Cut Pro frontmost but the timeline
unfocused with a text-field focus target. The single MCP focus attempt ended
with `FINAL_CUT_NATIVE_APPLE_EVENT_TIMEOUT`; the post-focus inspection reported
Final Cut Pro no longer frontmost and no usable timeline window. Under the
verification prompt this is a safety blocker. No import, append, title, PIP,
mask, canonical execute, export, or Undo call was made.

## Read-only retries

A later read-only retry reached the same boundary. The process fingerprint and
effective native canonical mode were unchanged. `project.list` failed because
Final Cut Pro was not frontmost, and `editor.native.inspect` returned
`frontmost: false`, no timeline window, and
`FINAL_CUT_NATIVE_APPLE_EVENT_TIMEOUT`. No focus or mutation retry was made.
This reinforces the blocker; it does not add headed-native operation proof.

A third consecutive goal-turn audit produced the same result. The MCP process
still reported version `0.1.7`, `final-cut-native-canonical`, `headed`, and
`canonical-live`; `project.list` again stopped at
`FINAL_CUT_CANONICAL_NOT_FRONTMOST`, while `editor.native.inspect` again
reported no frontmost Final Cut window, no timeline window, and
`FINAL_CUT_NATIVE_APPLE_EVENT_TIMEOUT`. The repeated condition requires an
external Final Cut state change before safe target inspection can continue.

After the blocked goal was resumed, the first fresh audit observed a partial
UI-state change: Final Cut Pro was frontmost and `editor.live.inspect` again
reported the verification project label, sequence timing, and live revision.
However, both `project.list` and `project.inspect` reached the canonical XML
automation path and failed with
`FINAL_CUT_CANONICAL_EXPORT_WINDOW_UNAVAILABLE`. The accompanying native
inspection still reported no timeline window and
`FINAL_CUT_NATIVE_APPLE_EVENT_TIMEOUT`. Live metadata does not replace a
complete canonical snapshot, so no focus, preview, or execute operation was
attempted. This is resume audit 1 for the current blocked-state audit cycle.

After the blocked goal was resumed, the first fresh read-only audit showed a
partial external-state improvement: Final Cut Pro was frontmost again and
`editor.live.inspect` returned the same active verification project label,
sequence timing, and revision. Canonical project discovery still failed at
`FINAL_CUT_CANONICAL_EXPORT_WINDOW_UNAVAILABLE`, and native inspection still
reported no timeline window plus `FINAL_CUT_NATIVE_APPLE_EVENT_TIMEOUT`. One
content-preserving `editor.native.focus` attempt against the explicitly named
E2E target returned the same timeout, and its immediate native readback still
showed no timeline window or focus. Live metadata does not replace the missing
canonical snapshot or native focus proof, so the resumed run also stopped
before preview or mutation.

The second fresh resumed audit returned the same effective v0.1.7 native
canonical process and the same Final Cut boundary. Final Cut Pro remained
frontmost, but `project.list` again failed at
`FINAL_CUT_CANONICAL_EXPORT_WINDOW_UNAVAILABLE` and native inspection again
returned no timeline window with `FINAL_CUT_NATIVE_APPLE_EVENT_TIMEOUT`.
Because no external state had changed since the failed focus attempt, focus
was not retried blindly. Preview and mutation remained not run.

The third fresh resumed audit reconfirmed the effective v0.1.7 native
canonical process fingerprint. `project.list` failed before a snapshot with
`FINAL_CUT_CANONICAL_NOT_FRONTMOST: Final Cut Pro must be frontmost`.
The final read-only `editor.native.inspect` returned `frontmost: false`,
`timelineFocused: false`, `focusTarget: text-field`,
`focusedRole: AXTextField`, `focusedDescription: text search`,
`timelineWindowAvailable: true`, `bladeAvailable: false`,
`undoAvailable: false`, and
`FINAL_CUT_NATIVE_APPLE_EVENT_TIMEOUT`. No focus retry, media import,
preview, execute, export, or Undo call was made.

## Release decision

Milestone 6 is not passed by this run. The new v0.1.7 native canonical process
and its capability payload are confirmed, but no headed-native placement,
duration/revision change, canonical diff, or Undo restoration was measured.
The minimal next prerequisite is a responsive, frontmost Final Cut Pro
timeline window that the native bridge can inspect, followed by a fresh
read-only target confirmation before any disposable mutation.
