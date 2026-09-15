# Shadow `.fcpbundle` mutation experiment

This document defines the experimental, shadow-only write path for issue #328.
It does not make direct mutation of a user library a supported publishing
contract.

## Safety contract

- The source bundle is read-only. Framekit copies it to a newly created shadow
  directory before opening SQLite for write access.
- The mutation target must be an explicit `CurrentVersion.fcpevent` database
  below that shadow bundle. Paths outside the shadow bundle fail closed.
- The writer accepts only a versioned, allowlisted schema recipe. Unknown
  schemas, missing columns, opaque timeline payloads, and integrity failures
  fail before committing a mutation.
- Framekit saves a byte-for-byte SQLite backup next to the shadow database,
  verifies SQLite integrity after the transaction, and records source and
  result digests.
- The first supported recipe is a reversible collection-name update. It proves
  shadow copy, transaction, and database integrity only; it is not a timeline
  edit or a claim that Final Cut accepts the mutated bundle.

## TDD sequence

1. Add deterministic tests for rejecting source writes, escaping paths, and
   unsupported schemas before any mutation code exists.
2. Add a shadow workspace that clones a bundle and returns only validated
   database paths.
3. Add the allowlisted transactional recipe, backup, digest, and integrity
   checks; test rollback and all fail-closed branches.
4. Wire the background-capable session publisher to use the shadow experiment
   only when explicitly configured. Persist the exact desired Timeline IR and
   claim jobs atomically before publication.
5. Run the disposable-library Final Cut reopen matrix. A locked console or a
   failed reopen is evidence that the experiment is unproven, not success.

## Exit evidence

Deterministic tests can prove the safety contract. Final Cut proof additionally
requires a disposable library, a successful Final Cut reopen, target-bound
readback, and the unlocked/backgrounded/console-locked matrix. No code path
may report headed-native verification without that evidence.
