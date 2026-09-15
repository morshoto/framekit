# Locked-console FCPXML experiment

Issue #314 records the boundary between the programmatic FCPXML artifact path
and a real Final Cut import. The experiment is deliberately read-only: it
reads an existing FCPXML artifact through `FcpxmlDocumentAdapter`, observes
Final Cut process/frontmost state, reads the supported macOS console-lock
signal, and optionally records whether a library directory and log file are
observable. It never imports, mutates, replaces, or overwrites a project.

Run the read-only preflight with a staged artifact:

```sh
FRAMEKIT_FCPXML_PATH=/absolute/path/to/artifact.fcpxml \
  pnpm run test:final-cut-fcpxml-console-experiment
```

An explicit-consent disposable import/readback scenario is available for an
unlocked experiment. It requires a pre-created disposable library and never
runs by default:

```sh
FRAMEKIT_FCPXML_PATH=/absolute/path/to/artifact.fcpxml \
FRAMEKIT_FINAL_CUT_LIBRARY_PATH=/absolute/path/to/disposable-library \
FRAMEKIT_FINAL_CUT_EXPERIMENT_CONFIRM=1 \
  pnpm run test:final-cut-fcpxml-console-experiment -- --execute
```

The execute mode records sanitized before/after project and sequence
identities. A background/unlocked run exercises the same import path and
records the frontmost or activation blocker if Final Cut cannot accept the
request without becoming frontmost. A locked or unknown console state stops
before import.

The JSON result is classified as:

| Status | Meaning |
| --- | --- |
| `artifact-only` | The FCPXML artifact was read, but Final Cut was not running or frontmost. |
| `headed-preflight-ready` | Final Cut was running and frontmost and the console was observed unlocked. This is preflight only, not import proof. |
| `blocked` | Artifact validation failed or a native precondition was not safe to continue. |

The classifier preserves the exact lock source. On 2026-09-14, the required
headed preflight stopped before any scenario because this host reported:

```text
code=FINAL_CUT_NATIVE_CONSOLE_LOCKED
state=locked
source=IOConsoleLocked
retryable=false
```

This is the blocker for the current experiment. It is not evidence that a
locked console can import FCPXML, and no native placement, target binding,
read-after-write, or Undo result is claimed.

Even when the preflight is ready, the result keeps
`targetBoundReadback: unavailable`, `nativeImportVerified: false`, and
`safeToOverwrite: false`. The existing headed publisher remains the separate
explicit-consent path for a future disposable import experiment. Its proof
must independently establish the exact project and sequence identity, process
and library/log evidence, post-import timeline readback, and rollback.

The experiment's environment observations are intentionally summarized:
library and log paths are not emitted, and no private media or native state is
serialized into the result.
