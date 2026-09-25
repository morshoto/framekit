# Layered Final Cut timeline readback

This document defines the trust boundary for re-understanding a Final Cut
timeline during an editing session. It keeps cheap observations useful without
promoting incomplete evidence to canonical timeline truth.

## Readback layers

| Layer | What it answers | Trust level | Allowed use |
| --- | --- | --- | --- |
| Live observation | Has Final Cut's selected project, sequence, playhead, or revision changed? | metadata-only | freshness signals and target diagnostics |
| Fast snapshot | Which supported timeline fields were observed by the experimental pasteboard provider? | experimental, non-canonical | session reconciliation when coverage and identity are sufficient |
| Editing session / Timeline IR | What base state and reviewed desired state does Framekit hold? | provider-neutral shadow state | previews, diffs, stale detection, and materialization planning |
| Canonical resync | What complete target-bound timeline does Final Cut expose? | canonical-read | initial binding, escalation, final verification, and explicit inspection |
| Semantic media index | What speech, scenes, subjects, motion, or loudness occur in source ranges? | source-media analysis | content explanations and edit planning, never timeline proof |

The live and fast layers are observations, not substitutes for a complete
canonical snapshot. The semantic layer describes source media independently of
timeline structure; it is joined to occurrences only through an explicit media
identity and source range.

## Normal loop and escalation

The normal agent loop is:

1. observe the target and revision;
2. apply a reviewed operation to the provider-neutral session;
3. perform operation-local verification;
4. use fast observation evidence when its required fields are complete;
5. reconcile the session and continue without opening Export XML.

Canonical resync is required when any of these conditions holds:

- there is no trustworthy target-bound base snapshot;
- the live revision changed outside the expected Framekit operation;
- occurrence or resource identity is ambiguous;
- required collections or timing fields are missing from fast evidence;
- fast evidence conflicts with the session or desired state;
- a final verification or caller explicitly requires complete structure.

An escalation result must identify the reason and preserve the last known
session state. It must not silently replace the session with a partial
observation. If canonical resync is unavailable, the operation remains
`possibly_stale` or `canonical resync required` and edits that depend on fresh
structure fail closed.

## Freshness and reconciliation

Fast observations may mark a session unchanged or advance it only when the
stable target, revision relationship, occurrence identity, source binding, and
required coverage are all proven. Missing collections are unknown, not empty.
Name-only matches are never authorization for reconciliation.

An external Final Cut change is distinct from an expected Framekit edit. The
session becomes `possibly_stale` until a fast observation proves the expected
change or canonical resync establishes a new base. A contradiction becomes a
conflict and requires explicit resolution before materialization.

## Safety boundary

Read paths must not mutate timeline or media content. Temporary focus, select,
or copy actions used by an experimental provider must be isolated and either
restored or reported as a side effect. A malformed payload, unavailable copy
command, incomplete coverage, or version-unknown private object must fail closed.

The `canonicalDocument.read` capability remains reserved for a complete,
target-bound canonical provider. Metadata-only, experimental pasteboard, cached
session, fixture, and semantic-media evidence cannot satisfy that capability.

## Follow-up implementation contracts

- #416 decodes the private pasteboard payload as experimental evidence.
- #417 normalizes and reconciles fast observations into Timeline IR.
- #418 routes headed FCPXML export as an explicit canonical checkpoint.
- Source-media analyzers remain separate from all timeline-structure providers.
