# Headless Project Transactions

Issue: [#402](https://github.com/morshoto/framekit/issues/402)

Status: v0.1.15 implementation contract

`ProjectTransactionService` is the provider-neutral mutation boundary for the
Framekit-owned project. It reuses `EditingSession` to apply existing Timeline
IR operations to an in-memory clone and `FramekitProjectStore` to persist the
result.

## Command contract

Every command has schema version 1, an explicit project and sequence target, an
expected project revision, and an ordered list of Timeline IR operations. The
target and expected revision are checked against the persisted project before
the operation list is evaluated.

Preview returns canonical before/after snapshots, stable content digests, the
ordered operations, and changed logical IDs. It does not write the project,
advance the revision, call a provider, or touch local media.

Execute repeats the target and revision checks, applies the command to a clone,
requires exactly one revision increment, updates project metadata, and commits
through the atomic project store. An invalid operation, stale revision, target
mismatch, or failed persistence leaves the previously valid project unchanged.

The service has no Final Cut or NLE dependency. A provider synchronization or
renderer can consume the committed canonical result later, but is never
implicitly invoked by preview or execute.
