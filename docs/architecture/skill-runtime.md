# Generic Skill runtime

`SkillRuntime` and `SkillRegistry` live under `@framekit/runtime`. Registration
is in-process and rejects duplicate ID/version pairs. Listing is sorted by
stable ID and semantic version; lookup can pin an exact version or select the
highest registered version.

The runtime resolves a manifest against the active session before invoking a
handler. It validates the manifest input schema, normalizes input, and gives
the handler only a frozen read-only planning context containing a project
snapshot, capabilities, and base revision. The handler returns semantic
operations; it never receives an editor adapter.

Preview creates a runtime-issued, short-lived token and delegates the semantic
operations to the existing non-mutating composite preview boundary. Execution
consumes the token before checking expiry or revision, rechecks current
requirements, and delegates to the transaction manager. Verification failures
are returned as a rolled-back Skill execution with transaction and rollback
evidence. Unknown, expired, reused, or stale tokens fail closed.
