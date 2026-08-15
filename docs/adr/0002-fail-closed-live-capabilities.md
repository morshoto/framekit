# ADR-0002: Fail Closed for Unsupported Live Capabilities

- Status: Accepted
- Date: 2026-08-16

## Context

The public Workflow Extension surface provides useful live sequence metadata,
but does not guarantee a complete clip and media enumeration API. Treating a
partial result as a canonical timeline could cause unsafe agent edits.

## Decision

The live adapter reports only capabilities it can verify. Complete timeline
reads, writes, read-after-write, rollback, playback, analysis, and native asset
operations return `CAPABILITY_UNAVAILABLE` until supported native APIs exist.

## Consequences

- Agents receive an honest machine-readable boundary.
- FCPXML remains available for the supported canonical edit path.
- The live adapter cannot yet execute the full PRD filler-removal loop.
- New capabilities require a native proof and adapter contract tests before
  being enabled.
