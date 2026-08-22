# MCP Tools

## Common runtime tools

| Tool | Purpose | Backend notes |
| --- | --- | --- |
| `connection.status` | Framekit Final Cut setup and connection state | Available during live setup and reconnect |
| `editor.inspect` | Editor identity and capabilities | Available when a backend is selected |
| `editor.native.inspect` | Active native Final Cut selection/playhead and UI focus diagnostics | Requires native writes opt-in and Accessibility permission |
| `editor.native.focus` | Activate Final Cut and focus the timeline without editing | Bounded retry; returns focus diagnostics on failure |
| `editor.native.edit` | Selection-scoped native Final Cut edit | Requires native writes opt-in and Final Cut frontmost |
| `editor.native.undo` | Final Cut native Undo for an accepted native edit | Requires native writes opt-in |
| `editor.native.media.search` | Search the active Final Cut Browser | Returns short-lived media handles; native writes required |
| `editor.native.media.select` | Select a Browser result by handle | Fails if the result or selection cannot be verified |
| `editor.native.timeline.locate` | Locate timeline occurrences for a Browser result | Requires exactly one match and timeline focus before automatic editing |
| `editor.native.blade.preview` | Prepare a Blade-at-playhead preview token | Token expires and is bound to the occurrence |
| `editor.native.blade.execute` | Execute a previewed Blade-at-playhead operation | Requires frontmost, timeline-focused Final Cut and post-command verification |
| `editor.native.delete-range.preview` | Preview a primary-storyline ripple delete for a rational time range | Destructive; requires explicit execute and timeline focus |
| `editor.native.delete-range.execute` | Execute a previewed primary-storyline ripple delete | Requires unchanged sequence revision and duration |
| `editor.native.trim-to-duration.preview` | Preview removal of the sequence tail after a requested duration | Preserves the beginning; destructive; requires explicit execute and timeline focus |
| `editor.native.trim-to-duration.execute` | Execute a previewed trim-to-duration operation | Requires unchanged sequence revision and duration |
| `context.inspect` | Queryable agent editing context | Backend-dependent |
| `context.changes` | Incremental timeline, live-state, and asset changes | Backend-dependent; fails closed when unavailable |
| `project.inspect` | Canonical project snapshot | Fixture/FCPXML-backed Final Cut session |
| `project.list` | Stable project and sequence catalog plus active IDs | Deterministic fixture and FCPXML-backed session; live-only Final Cut is unavailable |
| `project.select` | Select a project and explicit sequence when needed | Deterministic fixture and FCPXML-backed session; ambiguous targets fail closed |
| `timeline.inspect` | Canonical timeline snapshot | FCPXML-backed Final Cut session; not live-only |
| `timeline.changes` | Canonical timeline diff | Fixture/FCPXML-backed Final Cut session |
| `timeline.edit` | Supported Phase 0 edits | Fixture/FCPXML artifact path |
| `timeline.publish.new-project` | Import a verified FCPXML artifact as a new project | Requires verified `transactionId`, FCPXML path, and native writes; never replaces the active project |
| `media.inspect` | Normalized media context | Fixture/FCPXML-backed Final Cut session |
| `media.search` | Search media references | Fixture/FCPXML-backed Final Cut session |
| `speech.analyze` | Speech and filler analysis | Fixture or configured local JSON provider |
| `audio.analyze` | Loudness, peak, and silence analysis | Fixture or configured local JSON provider |
| `visual.analyze` | Scenes, subjects, motion, and keyframes | Fixture or configured local JSON provider |
| `media.understand` | Combined speech, audio, and visual understanding | Configured providers required for Final Cut |
| `editor.assets` | Search native editor assets by text, kind, or vendor | Fixture or Motion-template registry |
| `edit.diff` | Transaction diff | Fixture/FCPXML transaction path |
| `edit.verify` | Verification results | Fixture/FCPXML transaction path |
| `edit.undo` | Restore a transaction | Fixture/FCPXML transaction path |

## Live Final Cut tools

| Tool | Input | Result |
| --- | --- | --- |
| `editor.live.inspect` | none | Active project, sequence, playhead, range, and revision |
| `editor.live.changes` | `sequence`, optional `waitMs` | Events after the requested revision |

Live Final Cut state is not presented as a complete canonical timeline. When
`FRAMEKIT_FCPXML_PATH` is configured, canonical tools use that artifact while
`editor.live.*` continues to report the actual open Final Cut state.

`project.list` and `project.select` use stable IDs supplied by the selected
backend. The current Workflow Extension exposes only the active project and
sequence metadata, not a project browser or project-selection API, so a
live-only session rejects these tools with `CAPABILITY_UNAVAILABLE`. An
FCPXML-backed session can inspect and select its single managed project;
selection never silently changes the open Final Cut project.

`media.search` remains canonical snapshot search. Live Browser search uses the
explicit `editor.native.media.*` tools because Browser media identity and
timeline occurrence identity are different and short-lived.
