# Provider-neutral headless render contract

The headless renderer boundary accepts an immutable Timeline IR revision and
explicit output parameters. It does not depend on an editor adapter or expose
FFmpeg/AVFoundation types to the canonical runtime.

The contract has four stages:

1. `createFramekitRenderRequest` validates the project and sequence identity,
   exact revision, output format, dimensions, and rational frame rate.
2. A provider reports capability status for the required canonical features:
   local media, structural edits, gain, transform, titles, and cross-dissolve.
   `supported` is required; `degraded` and `unsupported` are explicit blockers.
3. `createFramekitRenderPlan` snapshots the Timeline IR and parameters and
   computes a deterministic plan digest bound to the project revision and
   renderer identity/version.
4. A provider returns a rendered artifact result containing the explicit output
   path, renderer provenance, project revision, and plan digest.

Provider success deliberately sets `verificationRequired: true`. Independent
artifact verification is a later gate owned by the render orchestration issue;
the provider result is never treated as proof that the file is playable or
semantically correct. Request and plan creation are read-only and do not
modify canonical project state or source media.
