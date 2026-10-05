# Deterministic headless render fixtures

The v0.1.15 QA fixture manifest describes two one-second local sources:

- a red 320x180 video with a 440 Hz mono tone;
- a blue 320x180 video with an 880 Hz mono tone.

`node scripts/generate-headless-render-fixtures.mjs <output-directory>`
regenerates the small MP4 inputs and copies the manifest into the requested
directory. The generator uses repository-controlled FFmpeg lavfi inputs,
single-threaded encoding, stripped metadata, explicit dimensions, frame rate,
sample rate, and channel count. No user media is read or modified, and no
binary fixture is required in Git.

The manifest also records the machine-readable canonical edit assertions:
source order and exact ranges, opening/closing title windows, the cross-dissolve
boundary and duration, the representative transform, the required gain, and
the expected output dimensions/frame rate/duration. The integration test
regenerates both inputs and verifies their streams independently with ffprobe.
