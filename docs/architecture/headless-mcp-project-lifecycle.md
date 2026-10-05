# Headless MCP project lifecycle

The `headless.*` MCP tools expose Framekit-owned project state as the normal
headless editing surface. They use the persistent project store and Timeline
IR directly; they do not select, launch, foreground, or synchronize Final Cut
Pro.

The lifecycle is:

- `headless.project.create`, `headless.project.list`, `headless.project.open`,
  and `headless.project.inspect` manage and inspect project documents under the
  configured Framekit state directory.
- `headless.media.register` resolves one local regular file, records its
  digest and ffprobe metadata, and advances the canonical project revision.
- `headless.edit.preview` is non-mutating. `headless.edit.execute` requires the
  expected revision and persists one guarded transaction from #402.
- `headless.render` loads the persisted revision, invokes the provider-neutral
  renderer, independently verifies the output, and persists a render record.
  `headless.render.inspect` reads that record after a process restart.

All errors are structured and fail closed for stale revisions, changed or
missing media, unsupported operations, unavailable FFmpeg/ffprobe, and failed
artifact verification. A renderer result is not reported as a completed
workflow until the independent verification status is `passed`.
