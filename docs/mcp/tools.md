# MCP Tools

## Common runtime tools

| Tool | Purpose | Backend notes |
| --- | --- | --- |
| `editor.inspect` | Editor identity and capabilities | Available when a backend is selected |
| `project.inspect` | Canonical project snapshot | Fixture/FCPXML only currently |
| `timeline.inspect` | Canonical timeline snapshot | Not available from live Final Cut |
| `timeline.changes` | Canonical timeline diff | Fixture/FCPXML only |
| `timeline.edit` | Supported Phase 0 edits | Fixture/FCPXML only currently |
| `media.inspect` | Normalized media context | Backend-dependent |
| `media.search` | Search media references | Backend-dependent |
| `speech.analyze` | Speech and filler analysis | Fixture provider currently |
| `audio.analyze` | Loudness, peak, and silence analysis | Fixture provider currently |
| `visual.analyze` | Visual analysis | Unavailable until Phase 2 |
| `editor.assets` | Native editor assets | Backend-dependent |
| `edit.diff` | Transaction diff | Fixture/FCPXML transaction path |
| `edit.verify` | Verification results | Fixture/FCPXML transaction path |
| `edit.undo` | Restore a transaction | Fixture/FCPXML transaction path |

## Live Final Cut tools

| Tool | Input | Result |
| --- | --- | --- |
| `editor.live.inspect` | none | Active project, sequence, playhead, range, and revision |
| `editor.live.changes` | `sequence`, optional `waitMs` | Events after the requested revision |

Live Final Cut state is not presented as a complete canonical timeline. This
prevents agents from mistaking partial native metadata for a full snapshot.
