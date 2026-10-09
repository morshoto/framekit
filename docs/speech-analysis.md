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
export FRAMEKIT_SPEECH_ANALYZER_VERSION=local-whisper-vad@1
export FRAMEKIT_SPEECH_REQUIRE_VAD=1
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

For a direct local Whisper transcription backend, the repository also includes
[`scripts/whisper-speech-backend.py`](../scripts/whisper-speech-backend.py).
It uses an already-installed `mlx-whisper` or `openai-whisper` package, keeps
the model outside the repository, and emits source-time word evidence. MLX is
the preferred backend on Apple Silicon; the OpenAI Whisper package is a
portable fallback:

```sh
python3 -m venv /absolute/path/to/framekit-whisper-venv
/absolute/path/to/framekit-whisper-venv/bin/pip install mlx-whisper
export FRAMEKIT_SPEECH_ANALYZER=/absolute/path/to/framekit/scripts/speech-analyzer-wrapper.mjs
export FRAMEKIT_SPEECH_BACKEND=/absolute/path/to/framekit/scripts/whisper-speech-backend.py
export FRAMEKIT_WHISPER_BACKEND=mlx-whisper
export FRAMEKIT_WHISPER_MODEL=mlx-community/whisper-tiny
export FRAMEKIT_WHISPER_LANGUAGE=en
export FRAMEKIT_SPEECH_ANALYZER_VERSION=mlx-whisper@<installed-version>/whisper-tiny
```

The backend requires `FRAMEKIT_WHISPER_MODEL` so model downloads remain an
explicit operator choice. It filters full-source Whisper output to a requested
source range and preserves absolute timestamps. It does not invent VAD; pair it
with the configured VAD/audio analyzer when a workflow requires speech/silence
boundaries. Missing Python packages, models, media, or backend output are
reported as structured setup, unavailable, or invalid-output failures.

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

When `FRAMEKIT_SPEECH_REQUIRE_VAD=1`, the configured provider must return VAD
segments; transcript-only output is rejected before a destructive Skill can
use it. `FRAMEKIT_SPEECH_ANALYZER_VERSION` records the local provider version
in the analyzer descriptor and every bound result, and is required when VAD is
enabled; startup fails with an actionable setup diagnostic when it is missing.

The normalized runtime and MCP response adds `schemaVersion: 1`, `mediaId`,
`sourceIdentity`, `requestedRange`, `observedRange`, `revision`, `provider`,
`sourceTimebase`, and `capability` to that evidence. A provider may omit these
fields because Framekit fills them from the trusted request; conflicting values
are rejected.

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
