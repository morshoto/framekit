# Local Speech Analysis

Framekit speech analysis is editor-independent. A configured local executable
can provide transcription and optional voice-activity detection (VAD) without
turning speech into a Final Cut capability.

## Setup

The repository includes an executable protocol wrapper at
[`scripts/speech-analyzer-wrapper.mjs`](../scripts/speech-analyzer-wrapper.mjs).
It delegates to one locally installed Whisper/VAD-compatible executable named by
`FRAMEKIT_SPEECH_BACKEND`; it does not bundle a model, credentials, or hosted
service. Both values are executable paths, not shell command strings with
embedded arguments:

```sh
export FRAMEKIT_EDITOR=final-cut-live
export FRAMEKIT_FCPXML_PATH=/absolute/path/to/project.fcpxml
export FRAMEKIT_SPEECH_ANALYZER=/absolute/path/to/framekit/scripts/speech-analyzer-wrapper.mjs
export FRAMEKIT_SPEECH_BACKEND=/absolute/path/to/whisper-vad-backend
pnpm run mcp
```

The wrapper exits with `SPEECH_ANALYZER_SETUP_REQUIRED` when the backend is
missing or not executable. Framekit reports that as an analyzer setup failure;
it is not reported as a Final Cut editor limitation. Confirm the setup before
starting MCP:

```sh
test -x "$FRAMEKIT_SPEECH_ANALYZER"
test -x "$FRAMEKIT_SPEECH_BACKEND"
```

## JSON protocol

Framekit writes one request to wrapper stdin and reads one JSON object from
stdout. The request contains only the source identity needed by the analyzer,
the inspected editor revision, and an optional source-media range:

```json
{
  "schemaVersion": 1,
  "media": {
    "mediaId": "media-1",
    "source": "/absolute/path/to/interview.wav",
    "sourceDigest": "sha256:...",
    "mediaKind": "audio",
    "duration": 120
  },
  "revision": {
    "id": "rev-4",
    "sequence": 4,
    "timestamp": "2026-09-10T00:00:00.000Z"
  },
  "range": { "start": 10, "end": 20 }
}
```

The backend returns a speech object. `words` is required; all other evidence
is optional:

```json
{
  "words": [
    { "text": "hello", "start": 10.2, "end": 10.8, "confidence": 0.98 }
  ],
  "vadSegments": [
    { "start": 10, "end": 11, "kind": "speech" },
    { "start": 11, "end": 12, "kind": "silence" }
  ],
  "silenceSegments": [
    { "start": 11, "end": 12, "kind": "silence" }
  ],
  "protectedSegments": [
    { "start": 12, "end": 12.2, "kind": "breath" }
  ],
  "sourceTimebase": { "value": "1", "timescale": "1000" }
}
```

Timestamps are source-media seconds. Words and each segment list must be
finite, ordered, positive, non-overlapping, and within the observed media
range. Word confidence and optional segment confidence are between `0` and
`1`. Validated runtime results are bound to the requested media identity,
revision, requested/observed range, provider descriptor, and source timebase.
Conflicting provider metadata fails closed rather than authorizing an edit.

## Capability truthfulness

`editor.inspect` retains the legacy `speechTranscribe` and `speechVad` flags
and adds `speechCapability`:

- `unavailable`: no speech analyzer is configured;
- `transcription-only`: words are available without VAD;
- `transcription-plus-vad`: words and VAD segments are available.

The normalized `speech.analyze` result carries the same distinction. Missing
VAD is never silently converted into silence or protected speech evidence.
Fixture analyzers remain deterministic test providers and are never evidence
that live Final Cut performed speech analysis.

## Safety boundary

Speech evidence can be mapped to a specific trimmed or offset timeline
occurrence only when its media identity and revision match, its source and
sequence durations agree, and the sequence occurrence has exact rational
timing. The runtime rejects stale, ambiguous, partial, unordered, overlapping,
out-of-range, and non-frame-safe mappings before a filler-removal operation is
planned.
