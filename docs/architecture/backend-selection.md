# Backend Selection

Final Cut currently has two intentionally separate paths:

| Backend | Best use | Limitation |
| --- | --- | --- |
| FCPXML | Canonical timeline reads, supported writes, read-after-write, diffs | Requires file interchange |
| Workflow Extension IPC | Live project/sequence metadata, playhead, range, events | Does not expose a complete timeline or writes |
| Local analyzer commands | Speech, audio, and visual media analysis | Requires configured executable providers |
| Motion-template registry | Installed transitions, effects, titles, generators, and audio effects | Read-only filesystem discovery |

The runtime should prefer the safest available backend for each capability. A
live connection must not silently downgrade to a fixture or claim that an
incomplete native snapshot is canonical. With `FRAMEKIT_FCPXML_PATH`, the
session composes both providers and keeps their capabilities separate.

## Select the editing surface first

Choose the target surface from the requested outcome before selecting a
backend:

| Requested outcome | Surface | Required target |
| --- | --- | --- |
| Change the managed FCPXML file | `artifact.edit` | Managed artifact ID and exact path |
| Import an edited artifact as a new project | `artifact.publish` | Verified artifact transaction, exact path, and `confirm: true` |
| Change the open Final Cut timeline | `editor.timeline.edit` | Explicit project ID, sequence ID, and base revision |

`artifact.edit` never implies a live Final Cut write, and
`editor.timeline.edit` never falls back to an artifact write. Publishing is an
explicit create/import operation: it reports the created project and the active
project before and after, and does not silently replace the active project.
Backends that cannot identify or verify the requested target fail closed.
