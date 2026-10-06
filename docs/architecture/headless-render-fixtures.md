# Deterministic headless render fixtures

The v0.1.15 QA fixture manifest describes three small local sources:

- a two-second red 320x180 video with a 440 Hz mono tone;
- a two-second blue/cyan 320x180 video with a 880 Hz mono tone and a white marker;
- a one-second green 320x180 video with a 1320 Hz mono tone.

The canonical workflow uses one-second source ranges from the red and blue/cyan
assets. The second asset changes from blue to cyan at 0.5 seconds, so its
declared non-zero source range selects frames that are visually distinct from
an accidental range beginning at zero. The manifest records the sample times,
pixel coordinates, and expected colors for that source.

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
regenerates all inputs, checks the blue-to-cyan samples by pixel value, and
verifies their streams independently with ffprobe.
