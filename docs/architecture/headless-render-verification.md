# Headless render and verification

`renderAndVerifyFramekitProject` owns the closed loop for a selected immutable
Timeline IR revision:

1. build a capability-checked render plan;
2. invoke the configured `FramekitRenderProvider`;
3. check that the provider result remains bound to the exact target, revision,
   renderer identity/version, plan digest, and explicit output path/format;
4. invoke an independent artifact verifier; and
5. evaluate any deterministic fixture semantic assertions.

The overall result is `passed` only when every gate passes. Provider success by
itself is never completion. Render failures and verification failures are
reported separately from `unavailable` states such as an unconfigured FFmpeg
or ffprobe executable.

The FFmpeg verifier checks that the output is a regular playable file, records
its SHA-256 digest and size, and independently reads the container, streams,
dimensions, rational frame rate, and duration with ffprobe. The verifier does
not trust metadata returned by the renderer. Semantic assertions are supplied
by the deterministic fixture/evaluation layer and can inspect the verified
artifact alongside the exact render plan.
