# Headless Local Media Registration

Issue: [#399](https://github.com/morshoto/framekit/issues/399)

Status: v0.1.15 implementation contract

`LocalMediaRegistrar` binds explicitly selected regular local files to the
canonical Timeline IR. It does not import media into an NLE, and it never
writes the source file.

## Registration identity

Each registered resource stores:

- a stable logical resource ID derived from the normalized source path and
  SHA-256 source digest;
- the normalized local path and `sourceKind: "local-file"`;
- the source digest;
- exact duration and provider-neutral stream metadata supplied by an injected
  metadata probe; and
- the existing Timeline IR resource binding slot, when a later provider
  synchronization operation needs one.

The path and digest are both part of identity. A filename is never sufficient,
and two same-named files at different paths are distinct resources.

The metadata probe is an application boundary. A production probe may use a
local media tool, but the canonical runtime does not depend on Final Cut Pro,
its browser, or an NLE-specific media representation.

## Reopen safety

`LocalMediaRegistrar.reopen()` loads the schema-validated Framekit project and
rechecks every resource marked `sourceKind: "local-file"`:

- `MEDIA_MISSING` means the registered path is no longer a regular file;
- `MEDIA_CHANGED` means the current digest differs from the registered digest;
- `MEDIA_AMBIGUOUS` means the selected path is not a regular file, including a
  symlink that could make identity ambiguous.

These are explicit failures. Reopening never silently binds a replacement file
at the same path. The original media remains read-only throughout registration,
digest verification, and reopen checks.
