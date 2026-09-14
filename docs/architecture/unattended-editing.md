# Unattended editing workflow

`runUnattendedEditingWorkflow()` composes the safe portion of the v0.1.11
editing path:

```text
SQLite observation -> Timeline IR session -> BASE/OURS/THEIRS reconcile
                  -> versioned FCPXML artifact -> native preflight classification
```

The workflow is intentionally unattended and non-destructive. It can apply
operations to an in-memory `EditingSession`, reconcile a changed provider
revision, and compile the desired state to a new FCPXML string. It does not
call Final Cut UI, import XML, alter a library, mutate a managed artifact, or
overwrite a destination.

## Evidence boundaries

- SQLite input is summarized as `canonical: false`; a changed digest is
  storage-drift evidence, not a canonical timeline revision.
- A provider revision change must reconcile before materialization. Explicit
  conflicts stop the workflow and return no FCPXML artifact.
- A successful compile is `artifact-verified` evidence. Exact target binding,
  rational timing, digest, and resource mapping belong to that artifact.
- The native experiment is evaluated after compilation. A locked console,
  unknown lock state, absent process, or non-frontmost Final Cut is returned as
  a structured blocker. Native import is never attempted by this workflow.

The result always reports `mutationAttempted: false` and `overwritten: false`.
`nativeImportVerified: false` remains true even when headed preflight is ready;
native placement and Undo require the separate explicit-consent headed runner.

## Fail-closed sequence

1. Validate and apply the requested operations to the session's desired IR.
2. Reconcile against the provider IR when its revision differs from BASE.
3. Stop with `conflicted` if the three-way merge reports any conflict.
4. Assert materialization readiness and compile a deterministic FCPXML 1.11
   artifact with the explicit Final Cut project/sequence target.
5. Classify the environment without importing the artifact.

The integration contract covers the non-overlapping rebase path, SQLite
storage-drift summary, locked-console blocker, deterministic artifact output,
and conflict stop before materialization.
