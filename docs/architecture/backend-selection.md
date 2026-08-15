# Backend Selection

Final Cut currently has two intentionally separate paths:

| Backend | Best use | Limitation |
| --- | --- | --- |
| FCPXML | Canonical timeline reads, supported writes, read-after-write, diffs | Requires file interchange |
| Workflow Extension IPC | Live project/sequence metadata, playhead, range, events | Does not expose a complete timeline or writes |

The runtime should prefer the safest available backend for each capability. A
live connection must not silently downgrade to a fixture or claim that an
incomplete native snapshot is canonical.
