# FFmpeg headless Timeline IR renderer

`@framekit/headless-renderer` is the first concrete provider for the
provider-neutral render contract. It receives one immutable render plan and
produces an MP4 or MOV artifact with FFmpeg; it never opens Final Cut Pro or
mutates the canonical project or registered source media.

The provider resolves every referenced `local-file` resource, verifies its
registered SHA-256 digest, and rejects missing or changed sources before
starting FFmpeg. The supported v0.1.15 subset is a contiguous primary video
storyline with exact source ranges, audio gain, scale/position transforms,
text title overlays, and one canonical cross-dissolve. Markers, captions,
story elements, secondary tracks, unsupported roles, rotation, and unsupported
title font-family requests fail closed instead of being silently dropped.

Rendering is staged next to the requested output and atomically renamed only
after FFmpeg produces a file. The provider returns the render-contract result
with `verificationRequired: true`; independent ffprobe, digest, and semantic
verification remains a separate gate owned by the render-and-verify workflow.

The implementation accepts `FFMPEG_BIN` or an injected executable path. Title
rendering can use `FRAMEKIT_RENDER_FONT` when a deterministic font path is
required; common macOS and Linux font paths are used only as local fallbacks.
