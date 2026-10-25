# Codex video production runbook

This runbook exercises the installed Framekit Codex plugin against the
production stdio MCP server and local media. It keeps headless analysis,
rendering, and FCPXML creation separate from importing that FCPXML into Final
Cut Pro.

## Prepare Codex and local analysis

Install or update Framekit from its marketplace, then start a new Codex
session:

```sh
codex plugin marketplace add morshoto/framekit
codex plugin add framekit@framekit
```

For local branch verification, add the repository's local marketplace instead
of `morshoto/framekit`, install its `framekit` entry, and start a new Codex
session. Confirm the plugin manifest version and MCP build fingerprint so the
session's provenance identifies the code under test.

Before starting Codex, configure an executable local speech analyzer and its
version. Use the [local speech setup](https://github.com/morshoto/framekit/blob/main/docs/speech-analysis.md) if needed. A
configured audio analyzer is optional; the workflow must report it as
unavailable when absent. Set an isolated state directory for this run if you
want a disposable project:

```sh
export FRAMEKIT_SPEECH_ANALYZER=/absolute/path/to/speech-analyzer-wrapper.mjs
export FRAMEKIT_SPEECH_ANALYZER_VERSION=local-whisper-vad@1
export FRAMEKIT_SPEECH_REQUIRE_VAD=1
export FRAMEKIT_STATE_DIR=/absolute/path/to/codex-video-e2e-state
codex
```

Prepare three local video files named A, B, and C, plus a licensed local music
file. The requested source ranges below must be within the videos and supported
by the configured speech/VAD analyzer. Do not invent speech evidence or use a
fixture analyzer as proof of real transcription quality.

## Run the headless production flow

In Codex, give Framekit the paths to A, B, C, and the music file, then request
this controlled edit:

> Create a 30-second highlight in B-A-C order: B from source 5-13 seconds, A
> from 10-22 seconds, and C from 2-12 seconds. Add the opening title `FrameKit MVP Test` at timeline 0-6 seconds. Add the licensed music from 0-30 seconds
> at -12 dB, and set `sourceAudioPolicy` to `preserve-and-mix`. Export an MP4 and
> editable FCPXML to these paths. Show me the plan and preview, then wait for my
> approval. Do not import into Final Cut.

If the configured analyzer does not return VAD evidence covering those source
ranges, stop and request suitable ranges or sources. Never manufacture
analysis to satisfy the edit. The plugin should:

1. Call `connection.status`. A non-ready Final Cut connection is reported, but
   does not block the headless project workflow.
2. Create or open a named Framekit project. Use the revision returned by
   `headless.project.create`, or the current revision from
   `headless.project.inspect` after opening it. Register video sources A, B,
   and C plus the separate music file by passing that current revision as
   `expectedRevision` to every `headless.media.register` call. After each
   registration, replace it with the revision returned in the updated project.
   Retain the `projectId`, each returned `mediaId` and `sourceDigest`, and the
   latest project revision.
3. Call `media.understand` with `projectId` and each video source's `mediaId`.
   Confirm that speech output includes the configured provider version, VAD
   capability, exact source identity, and project revision for A, B, and C.
   Report each other modality as analyzed or unavailable.
4. Call `rough-cut.plan` with the same `projectId` and a transcript query. Check
   that the plan supplies evidence for the requested B, A, and C ranges. Keep
   the returned source identities, digests, VAD evidence, and revision; apply
   the requested B-A-C order without changing the evidence.
5. Include a title operation at timeline 0-6 seconds and an independent music
   occurrence at 0-30 seconds with gain `-12`, using the registered music ID.
   Call `headless.rough-cut.preview`; check the exact B-A-C sequence, `FrameKit
   MVP Test` title, independent music, output paths, and same canonical
   revision in its final timeline, operations, provenance, and plan digest.
   Supply the reviewed `fcpxml.target.libraryUid` as FCPXML destination
   metadata; it is not a native library identity or imported-target proof.
6. Show the plan, output paths, source-audio policy, and preview. Do not execute
   until the user approves this exact edit and its output settings. Then call
   `headless.rough-cut.execute` with the unchanged plan and operations, returned
   digest, and `approved: true`.
7. Confirm the result reports a verified MP4 and editable FCPXML, an
   `executionId`, source and canonical revisions, artifact path, and artifact
   digest. Confirm the MP4 exists and can be probed with `ffprobe`.

The ordered operations should use the registered music `mediaId`, track 1, and
exact rational coordinates, for example:

```json
[
  {
    "type": "insert-occurrence",
    "occurrence": {
      "id": "codex-video-e2e-music",
      "name": "Licensed music bed",
      "startTime": { "value": "0", "timescale": "1" },
      "durationTime": { "value": "30", "timescale": "1" },
      "sourceStartTime": { "value": "0", "timescale": "1" },
      "track": 1,
      "role": "music",
      "mediaId": "<registered-music-media-id>",
      "gainDb": -12
    }
  },
  {
    "type": "add-title",
    "title": {
      "id": "codex-video-e2e-title",
      "text": "FrameKit MVP Test",
      "startTime": { "value": "0", "timescale": "1" },
      "durationTime": { "value": "6", "timescale": "1" },
      "lane": 1
    }
  }
]
```

The headless leg must not invoke `artifact.publish.execute`, native Final Cut
tools, or UI automation. The result is a verified local video and an editable
FCPXML artifact; it is not a Final Cut import.

## Native delivery after separate authorization

Completing this handoff with the current packaged Codex workflow and headed
Final Cut readback is tracked in #541. The steps below document the guarded
contract; the headless acceptance for #520 does not claim that this native leg
ran.

Native delivery uses a separate headed MCP server. Follow
[Final Cut installation](https://github.com/morshoto/framekit/blob/main/docs/final-cut/installation.md) to configure a headed
server with `FRAMEKIT_EDITOR=final-cut-live`,
`FRAMEKIT_FINAL_CUT_HEADLESS=0`, `FRAMEKIT_FINAL_CUT_NATIVE_WRITES=1`, the exact
`FRAMEKIT_FCPXML_PATH`, and the intended new `targetLibraryPath` for the
publish preview. The library path is a tool argument, not a server setting.
Choose a separate new absolute `.fcpbundle` path whose parent exists and whose
destination does not; ask the user for missing destination details.

Keep the headless server and its verified output available. Set the headed
server's `FRAMEKIT_STATE_DIR` to the same absolute directory used for the
headless run. `artifact.publish.preview` loads the approved
`headlessExecutionId` from that directory; a different directory returns
`HEADLESS_ROUGH_CUT_EXECUTION_NOT_FOUND`. Do not start the headed handoff or
initiate an import unless the user asks for native delivery.

In the headed session:

1. Call `connection.status` and `editor.inspect`. Confirm Final Cut is ready
   and `capabilities.editor.artifactPublish` is available. If either check
   fails, report the blocker and stop before import.
2. Call `artifact.publish.preview` with the exact output `artifactPath` and
   headless `headlessExecutionId`, plus the new absolute `.fcpbundle`
   `targetLibraryPath`. Review its source proof, artifact digest, target
   project/sequence, and library path.
3. Show those details and ask the user to authorize importing that artifact
   into that library. Then call `artifact.publish.execute` with the returned
   `jobId` and literal `confirm: true`.
4. Read `artifact.publish.status` for that same job. Report successful delivery
   only when status is `verified` and includes a target-matching live readback.

If the job is `awaiting-final-cut`, retain its `jobId`, report that delivery is
pending, and wait until the user makes Final Cut ready. Inspect that same job
before retrying it; do not create a second job. If the job is
`verification-pending`, continue verification for the same job only. Never
repeat the import because readback is ambiguous. Report pending or blocked
when verification has not reached `verified`.

## Record the run

For issue #541, keep one evidence record for the exact tested checkout and
package. Record the repository commit; Codex CLI version; installed plugin
version and content fingerprint; MCP package version, commit, package digest,
and build fingerprint; Workflow Extension version and fingerprint; and macOS
and Final Cut versions. Do not infer an installed runtime or extension identity
from the source checkout.

For the approved headless edit, record the project ID, source revision,
canonical revision, headless execution ID, plan digest, source bindings, and
the source-media SHA-256 for A, B, C, and the separately registered music
asset. Record the headless preview digest and its approval record. Include the
verified MP4 and FCPXML paths in the private run record, their MP4 and FCPXML
SHA-256 values, output verification results, and the exact FCPXML artifact path
and digest passed to the native preview. A changed input or output requires a
fresh preview and approval.

For native delivery, record the native publish preview and its separate
approval record, the exact absolute `.fcpbundle` `targetLibraryPath`, publish
job ID, every status transition, and whether import ran. Record the created
library, event, project, and sequence identities in the matching created-target
readback, plus active-project before/after identities. Compare source bindings,
clip order and ranges, editable title, independent music, and supported audio
semantics with the approved canonical revision. If a path contains a
user-specific location, retain the exact value in the private run record and
redact it from shared evidence.

Link a sanitized Codex/MCP transcript and approval records. Remove credentials,
private media, and user-specific paths from shared evidence. Include recovery
evidence for rejected approval, stale input, unavailable or mismatched
capability, interruption, and verification-pending behavior; mark scenarios
that were not run as `not run` instead of inferring an outcome. Link the
sanitized report to #517. A successful headless result does not establish
native delivery; fixture tests and this runbook do not establish headed Final
Cut acceptance by themselves.

## Failure checks

- **Rejected approval:** leave the preview unexecuted. Do not retry with
  `approved: true` unless the user approves the exact plan and settings.
- **Stale revision:** discard the old plan digest. Reopen the project, recheck
  source digests, rerun understanding and planning against the current
  revision, and make a fresh preview.
- **Unavailable native provider:** report the missing `artifactPublish`
  capability or readiness requirement and keep the verified MP4/FCPXML. Do not
  switch to UI automation or infer that delivery occurred.
- **Interrupted handoff:** call `artifact.publish.status` for the same `jobId`
  before taking any action. Resume only the retryable state for that job;
  `verification-pending` must never create a second import.
