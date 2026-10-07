# Background editable Final Cut handoff

Framekit is an edit-decision engine and Final Cut Pro remains the user's
editing environment. A supported background workflow plans against a
provider-neutral Timeline IR, stores the desired state in an `EditingSession`,
and materializes a new versioned editable project through FCPXML.

```text
canonical/base sync -> Timeline IR -> EditingSession preview/confirm
                     -> deterministic FCPXML -> versioned project delivery
                     -> canonical readback -> user continuation
```

## Ownership and safety

The runtime owns edit decisions, exact rational ranges, source identity, and
session freshness. The Final Cut adapter owns FCPXML compilation, target
delivery, and provider readback. The MCP layer exposes the workflow and
reports its evidence; it must not invent native state.

Background materialization is create-only by default. It must preserve the
original project as the rollback/reference point, use stable library/event/
project/sequence identity, and preserve original media references. It must not flatten
the desired timeline into a movie as the editable handoff.

The session is stale when the provider revision changes after the base was
bound. Stale or conflicted state requires canonical resync and reconciliation
before materialization. A fast observation or metadata-only snapshot may guide
diagnostics, but never authorizes a canonical write or claims editable
readback.

## Materialization evidence

Every checkpoint keeps these layers separate:

1. deterministic FCPXML artifact and digest;
2. provider request and target identity;
3. canonical readback of the created project and Timeline IR;
4. headed-native evidence, only when separately observed.

Completion requires the target-bound canonical readback to match the desired
Timeline IR. Artifact creation, a successful process exit, or a provider
request alone is not success. Missing canonical readback is reported as
unavailable, and mismatches fail closed without changing the original project.

## Foreground and fallback policy

The preferred delivery path uses a supported macOS document-open or equivalent
bridge with foreground activation disabled where the platform permits it. The
result must report whether Final Cut activated, displayed UI, required user
interaction, or completed without a foreground side effect.

If the target library is unresolved, a chooser or conflict prompt appears, or
the requested Timeline IR feature is unsupported, the background path returns
an explicit unavailable or fallback state. A headed-native fallback is allowed
only when selected explicitly and must retain target validation, preview,
execution, canonical readback, and Undo boundaries. It must not be silently
substituted for background proof.

## Continuation

After a user opens the versioned project and makes manual changes, a later
Framekit request first chooses the readback route. Initial binding, stale or
conflicted state, incomplete fast coverage, and final verification require a
canonical resync. Only a target-bound canonical result can become the new
session base. This preserves the user's edits and prevents stale desired state
from overwriting them.

Deterministic tests prove the session and artifact contracts. Disposable live
Final Cut validation must separately record base revision, desired digest,
FCPXML digest, materialized identity, activation/UI side effects, canonical
readback, and any unavailable evidence. A fixture, FCPXML-only, metadata-only,
or GUI-only result is not native editable-project proof.
