# Getting started

Framekit can run as a local MCP server for deterministic headless editing or
connect to an explicitly configured Final Cut provider. Start with the
headless fixture; it does not launch or activate Final Cut Pro.

## Development setup

Contributor toolchain: Node.js 22.23.5 and pnpm 12.18.0.
Consumer runtime: Node.js >=20.
CI tests this contributor pair; the pre-commit hook accepts Node.js 22.23 or newer.
Install pnpm 12.18.0 using Corepack or your preferred package manager.
Xcode 16.4 with the macOS 15.5 SDK is required only for native extension work.
The optional Nix environment provides Node.js 22, pinned pnpm, FFmpeg/ffprobe,
and SQLite for fixture and headless development. Start with the fixture profile;
it does not require Apple tools or credentials:

```sh
nix develop ./nix
pnpm install --frozen-lockfile
pnpm run framekit -- doctor dev --profile fixture
pnpm run build
pnpm run test:fixtures
pnpm run smoke:fixture-mcp
```

See [the Nix development guide](../nix/README.md) for the Linux bootstrap and
`headless`/`native` doctor profiles. `doctor finalcut` keeps its existing
connection check.

Install and validate from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run hooks:install
pnpm run build
pnpm run test
pnpm run check:boundaries
pnpm run check:docs
```

The test and native evidence levels are described in [Testing](./testing.md).
Repository responsibilities and dependency direction are described in
[Architecture](./architecture.md).

### CLI entrypoint resolution

`bin/framekit.mjs` is the supported public CLI entrypoint. In a development
checkout it launches `apps/cli/src/main.ts` with the workspace TypeScript
loader; in a packed installation it launches
`dist-package/apps/cli/src/main.js`. Use the `framekit` command or the
`./bin/framekit.mjs` package export. Compiled app files and other private
implementation subpaths are not stable package APIs.

## Run Framekit locally

Start the deterministic in-memory MCP server from the repository root:

```sh
pnpm run mcp
```

For a development Final Cut connection, set the editor explicitly:

```sh
FRAMEKIT_EDITOR=final-cut-live pnpm run mcp
```

`FRAMEKIT_EDITOR` selects the configured backend. `FRAMEKIT_FCPXML_PATH` names
an explicit FCPXML artifact; it does not enable mutation of the open Final Cut
project. `FRAMEKIT_FINAL_CUT_SOCKET` selects the local Workflow Extension
socket. Inspect the reported capabilities before choosing an operation. A
ready metadata-only bridge does not imply canonical timeline read or write.

### Create an edit from JSON

An MCP client can turn an AI-authored edit into a Framekit-owned project and a
new editable FCPXML file without starting Final Cut Pro. Install FFmpeg and
ffprobe to register local sources. Start the MCP server in headless mode, then:

1. Call `headless.project.create` with an empty Timeline IR. For example, use
   the timeline below; choose fresh project and sequence IDs for each edit.
2. Call `headless.media.register` for each local video and audio file. Pass the
   current `expectedRevision` each time and use the returned revision in the
   next call. Save each returned `resource.id`; filenames are not identities.
3. Replace the three media ID placeholders in the edit below with those IDs.
   Call `headless.edit-json.preview` with `projectId`, `sequenceId`, the latest
   `expectedRevision`, and the edit as `edit`. Review its proposed timeline.
4. Call `headless.edit-json.execute` with the same arguments, `approved: true`,
   and the `planDigest` returned by preview. Use the returned
   `after.timeline.revision` as `expectedRevision` for
   `headless.fcpxml.export`; provide a new output path and an explicit Final Cut
   target with `materialization: "versioned"`.

For a semantic rough-cut plan, `headless.rough-cut.preview` also returns an MCP
PNG image and storyboard metadata alongside the existing JSON preview. The
sheet samples each primary shot start and each title midpoint in chronological
order; metadata identifies each sample's timeline and source time, media
digest, proposed revision, and plan digest. Inspect the image, revise the plan
or operations if needed, and preview again before executing with the new
digest and explicit approval. Preview does not change the project or source
media. The sheet is limited to 12 samples and a maximum of 640 × 360 pixels per
sample. It does not show motion or audio, and frame-rate conversion can select
a nearby source frame. Unsupported visual compositions or sample limits return
JSON and a plan digest without an image; `storyboardUnavailable` explains why.
FFmpeg and its drawtext support are required for storyboard rendering.

Publishing an approved rough cut requires its verified video and FCPXML to
remain at their approved paths with unchanged contents. The publish preview's
`sourceProof.renderArtifact` reports the checked video path, SHA-256 digest,
and byte count. Older rough-cut
execution records without a verified video identity cannot be published; use
new output paths and run a new approved preview and execution to create
current evidence.

Headless title rendering checks glyph coverage in the selected font and fails
when a glyph is missing or a variation or joined sequence cannot be verified.
Set `FRAMEKIT_RENDER_FONT` to a suitable font file when the default lacks the
needed characters. Glyph coverage alone does not establish visual correctness
or shaping.

For a headless cross-dissolve, the incoming source must have a pre-roll handle
at least as long as the transition. The blend uses that handle before the cut,
while frames and audio after the cut retain the approved source timing. The
renderer rejects insufficient handles before writing the output.

Headless render verification measures the first output audio stream's decoded
true peak using FFmpeg. The reported peak must be below 0 dBFS; a value rounded
to 0.0 dBFS fails conservatively. If verification reports an excessive peak,
reduce the mix gain and render again. A measurement failure also fails
verification. Silent audio is accepted.

Empty `timeline` for step 1:

```json
{
  "schemaVersion": 1,
  "project": { "id": "example-project", "name": "My edit" },
  "sequence": {
    "id": "example-sequence", "name": "My edit",
    "durationTime": { "value": "0", "timescale": "1" },
    "frameDuration": { "value": "1", "timescale": "30" },
    "occurrences": [], "storyElements": [], "markers": [], "captions": [],
    "titles": [], "transitions": []
  },
  "resources": [],
  "revision": { "id": "initial", "sequence": 0, "timestamp": "2026-01-01T00:00:00.000Z" }
}
```

Example `edit` for step 3, with two one-second clips and a two-second music bed:

Version 1 requires at least one clip; `title` and `music` are independently
optional. When present, each section must satisfy its normal validation rules.

External edit music `gainDb` must be between -60 and +12 dB inclusive. This
bound does not guarantee that the combined audio mix avoids clipping.

```json
{
  "schemaVersion": 1,
  "clips": [
    { "id": "shot-1", "mediaId": "VIDEO_ID_1", "sourceStartTime": { "value": "0", "timescale": "1" }, "durationTime": { "value": "1", "timescale": "1" } },
    { "id": "shot-2", "mediaId": "VIDEO_ID_2", "sourceStartTime": { "value": "1", "timescale": "1" }, "durationTime": { "value": "1", "timescale": "1" } }
  ],
  "title": { "id": "opening", "text": "Hello", "startTime": { "value": "0", "timescale": "1" }, "durationTime": { "value": "1", "timescale": "1" } },
  "music": { "id": "bed", "mediaId": "AUDIO_ID", "sourceStartTime": { "value": "0", "timescale": "1" }, "startTime": { "value": "0", "timescale": "1" }, "durationTime": { "value": "2", "timescale": "1" }, "gainDb": -12 }
}
```

For step 4, an export request has this shape; use the revision returned by the
execute call and choose a new file path and unique target IDs:

```json
{
  "projectId": "example-project", "sequenceId": "example-sequence",
  "expectedRevision": { "id": "EXECUTED_REVISION_ID", "sequence": 4, "timestamp": "EXECUTED_REVISION_TIMESTAMP" },
  "outputPath": "/path/to/new-edit.fcpxml",
  "target": { "provider": "final-cut", "libraryUid": "my-library", "eventUid": "my-event", "projectUid": "my-project-v1", "sequenceUid": "my-sequence-v1", "materialization": "versioned" }
}
```

Copy the complete revision object from the execute result; the revision values
above are placeholders, not a fixed sequence number.

Times are exact rational seconds and must align to the sequence frame grid.
Video source starts and durations must also align to the registered source frame
rate; source ranges must fit the probed video stream. If stream bounds are unavailable,
register the source in a new project or use media with probeable stream timing.
Version 1 supports an
ordered primary video sequence, one basic unstyled title contained in a single
clip, and one audio-only music source with static gain. The edit requires an
empty timeline; styling, unsupported effects, stale revisions, changed media,
and invalid or ambiguous sources are rejected. Preview and execute check
FCPXML support before committing an edit. The resulting file is a candidate
for manual import: artifact verification does not prove Final Cut import,
playback, editability, or video export.

### Optional analysis providers

Optional local analysis commands are selected with
`FRAMEKIT_SPEECH_ANALYZER`, `FRAMEKIT_AUDIO_ANALYZER`,
`FRAMEKIT_VISUAL_ANALYZER`, and `FRAMEKIT_METADATA_ANALYZER`. Each provider
receives one JSON request on standard input and returns a typed JSON result on
standard output. `FRAMEKIT_ANALYZER_TIMEOUT_MS` changes the bounded provider
timeout. Missing providers report unavailable analysis; they do not invent
media descriptions.

Audio results identify their measured signal with `signalScope`. Existing
source-file providers default to `source`; those results are useful for source
analysis but cannot verify timeline gain changes. Occurrence-aware providers
receive an explicit `occurrenceId` and must return that same ID with
`signalScope: occurrence`. Source-only or mismatched evidence cannot be used
as a post-edit occurrence measurement.

Audio payloads require finite loudness/peak values and nonnegative silence and
sample counts. Malformed payloads fail `audio.analyze`; `media.understand`
reports audio unavailable while preserving successful transcription and other
analysis. Providers may report `sourceTimebase` as a positive rational clock and
`signalFormat` with positive integer `sampleRate`/`channels` and an optional
nonempty `channelLayout`. Declared range timing and format are validated and
retained; absent technical metadata is not inferred.

For source-file loudness in a checkout, the optional
`apps/mcp-server/runtime/ffmpeg-audio-backend.py` command requires Python 3,
`ffmpeg` and `ffprobe` on `PATH`. Select it with `FRAMEKIT_AUDIO_ANALYZER` and
pin the installed FFmpeg and backend versions as part of your environment. The
executable also ships in the package's MCP runtime assets. It measures one
mono/stereo source audio stream with zero stream offset, returning integrated
LUFS, oversampled true peak and silence below -60 dB for at least 100 ms.
Requested bounds are quantized inward to sample coordinates; decoded coverage,
measured ranges, source clock and channel format are retained. Ambiguous
streams, short/silent or truncated signals and invalid tool output are
unavailable. Occurrence/output requests are rejected before media tools run;
this source measurement cannot verify a timeline gain change.

The existing Whisper backend can optionally run local Silero VAD. Install
`silero-vad`/PyTorch and provide a local JIT model through
`FRAMEKIT_SILERO_VAD_MODEL` plus its required SHA-256 in
`FRAMEKIT_SILERO_VAD_SHA256`; the backend never downloads a model. Include the
package/model/backend revisions in `FRAMEKIT_SPEECH_ANALYZER_VERSION`.
FFmpeg decodes the first audio stream to mono 16 kHz. The detector uses threshold
0.5, 250 ms minimum speech, 100 ms minimum silence and 30 ms speech padding.
Detected sample intervals are validated and clipped to the requested source
range; ASR word or segment timestamps are never substituted for VAD.

With optional VAD, detector failure leaves transcription available and reports
`vadUnavailableReason` without activity segments. `FRAMEKIT_SPEECH_REQUIRE_VAD=1`
instead rejects a combined result if VAD is unavailable. Successful results
retain request/source/revision/provider provenance and a 1/16000 analysis clock.
The Whisper transcription clock remains 1/16000 when optional VAD is unavailable;
it describes the decoded analysis signal, not the original media's sample rate.
After partial reanalysis, `vadCoverage` retains available segments and
unavailable reasons by source range. If coverage is incomplete, the merged
result reports transcription-only capability and omits top-level `vadSegments`;
partial VAD must not be treated as complete edit-safety evidence.
Reanalysis rejects legacy VAD evidence without an observed range instead of
silently assigning that evidence to a source range.
Reanalysis also rejects a merged speech result when the retained and newly
observed ranges leave a gap, rather than reporting continuous coverage.
These source-file capabilities do not establish native source observation,
sample-accurate activity reference labels or edit/Undo acceptance.

Use `connection.status` for connection diagnostics, `editor.inspect` for
backend and capability details, and `editing.route` for the requested
operation's selected path. Unsupported operations return a structured
unavailable result. The headless path does not launch, activate, or focus
Final Cut Pro.

## Connect Codex

The Codex plugin starts the published Framekit package; it does not install the
Final Cut Workflow Extension. Add the marketplace once:

```sh
codex plugin marketplace add morshoto/framekit
```

Then open `/plugins`, install **Framekit**, and start a new Codex session. The
published MCP server runs through `npx` and needs no repository checkout or
manual `codex mcp add` command. The plugin can also be installed from its
marketplace with `codex plugin add framekit@framekit`. The signed Workflow
Extension is a separate release asset; install it from the matching
[GitHub release](https://github.com/morshoto/framekit/releases) when a live
Final Cut connection is required.

Check connection readiness without starting MCP with:

```sh
npx -y @morshoto/framekit doctor finalcut
```

For more detail, use `connection.status` and `editor.inspect`.
`CAPABILITY_UNAVAILABLE` is an operation-level diagnostic: a ready live session
may expose metadata while rejecting unsupported operations. Inspect the
operation's capability before use.

## Connect Claude Code

Register the published package as a user-scoped stdio server:

```sh
claude mcp add --env FRAMEKIT_EDITOR=final-cut-live \
  --scope user --transport stdio framekit -- \
  npx -y @morshoto/framekit mcp --headless
claude mcp list
claude mcp get framekit
```

Headless mode does not launch, focus, or mutate Final Cut through UI
automation. Accessibility and Automation permissions are required only for an
explicit headed native-write workflow. Start a new client session after
changing its server registration.

For a development extension, build it from the checkout:

```sh
pnpm run xcode:check
bash adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/build.sh
pnpm run framekit -- connect finalcut --development
```

The explicit development connect command may gracefully reload Final Cut so
it loads the selected extension. Native editing remains a separate, explicitly
headed workflow with target binding, preview, readback, and Undo requirements.
See [Architecture](./architecture.md#headless-and-native-editing) before using
native capabilities.

For explicit local native validation, bind both processes to the same checkout
commit and require their build fingerprints to match:

```sh
FRAMEKIT_EDITOR=final-cut-live \
FRAMEKIT_FINAL_CUT_CANONICAL_PROVIDER=native \
FRAMEKIT_FINAL_CUT_NATIVE_WRITES=1 \
FRAMEKIT_FINAL_CUT_HEADLESS=0 \
FRAMEKIT_VALIDATION_COMMIT="$(git rev-parse HEAD)" \
pnpm run framekit -- mcp --editor final-cut-live --development
```

Register that development server as a separate Codex entry when testing a
clean client session:

```sh
codex mcp add framekit-local \
  --env FRAMEKIT_EDITOR=final-cut-live \
  --env FRAMEKIT_FINAL_CUT_CANONICAL_PROVIDER=native \
  --env FRAMEKIT_FINAL_CUT_NATIVE_WRITES=1 \
  --env FRAMEKIT_FINAL_CUT_HEADLESS=0 \
  --env FRAMEKIT_VALIDATION_COMMIT="$(git rev-parse HEAD)" \
  -- pnpm run framekit -- mcp --editor final-cut-live --development
```

Continue only when `preflight.buildAlignment.status` is `matched`. The MCP
process may use `FRAMEKIT_BUILD_COMMIT` for a reproducible external target;
the extension records its checkout commit in its bundle metadata. Accessibility
and Automation permissions are required only for an explicit headed
native-write setup.

For safe validation commands and the distinction between fixture, artifact,
metadata, canonical-live, and headed-native proof, see [Testing](./testing.md).
