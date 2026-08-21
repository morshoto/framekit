# MCP Tools

## Common runtime tools

| Tool | Purpose | Backend notes |
| --- | --- | --- |
| `connection.status` | Framekit Final Cut setup and connection state | Available during live setup and reconnect |
| `editor.inspect` | Editor identity and capabilities | Available when a backend is selected |
| `editor.native.inspect` | Active native Final Cut selection/playhead | Requires native writes opt-in and Accessibility permission |
| `editor.native.edit` | Selection-scoped native Final Cut edit | Requires native writes opt-in and Final Cut frontmost |
| `editor.native.undo` | Final Cut native Undo for an accepted native edit | Requires native writes opt-in |
| `context.inspect` | Queryable agent editing context | Backend-dependent |
| `context.changes` | Incremental timeline, live-state, and asset changes | Backend-dependent; fails closed when unavailable |
| `project.inspect` | Canonical project snapshot | Fixture/FCPXML-backed Final Cut session |
| `timeline.inspect` | Canonical timeline snapshot | FCPXML-backed Final Cut session; not live-only |
| `timeline.changes` | Canonical timeline diff | Fixture/FCPXML-backed Final Cut session |
| `timeline.edit` | Supported Phase 0 edits | Fixture/FCPXML artifact path |
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
