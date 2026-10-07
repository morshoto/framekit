# Layered Final Cut timeline readback

This document defines the trust boundary for re-understanding a Final Cut
timeline during an editing session. It keeps cheap observations useful without
promoting incomplete evidence to canonical timeline truth.

## Readback layers

| Layer | What it answers | Trust level | Allowed use |
| --- | --- | --- | --- |
| Live observation | Has Final Cut's selected project, sequence, playhead, or revision changed? | metadata-only | freshness signals and target diagnostics |
| Preferred background snapshot (#454) | Which supported timeline fields can the version-bound internal-runtime provider observe without taking focus? | version-bound, non-canonical until validated | normal read path when compatible and sufficiently covered |
| Pasteboard fallback (#416) | Which timeline fields are present in a copied private pasteboard payload? | experimental, non-canonical | optional fallback or diagnostics; report focus, selection, and clipboard effects |
| Editing session / Timeline IR | What base state and reviewed desired state does Framekit hold? | provider-neutral shadow state | previews, diffs, stale detection, and materialization planning |
| Canonical resync | What complete target-bound timeline does Final Cut expose? | canonical-read | initial binding, escalation, final verification, and explicit inspection |
| Semantic media index | What speech, scenes, subjects, motion, or loudness occur in source ranges? | source-media analysis | content explanations and edit planning, never timeline proof |

The live and fast layers are observations, not substitutes for a complete
canonical snapshot. The semantic layer describes source media independently of
timeline structure; it is joined to occurrences only through an explicit media
identity and source range.

## Normal loop and escalation

The normal v0.1.14 agent loop is:

1. observe metadata and change signals;
2. read through the compatible #454 background provider;
3. normalize and reconcile the observation into the existing session through #417;
4. apply a reviewed operation and perform operation-local verification;
5. continue without opening Export XML when coverage and freshness are sufficient.

Use the #416 pasteboard provider only as an optional fallback or diagnostic
source when needed. Preserve its lower trust level and report any focus,
selection, or clipboard side effects.

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

- The supported Apple Events / Workflow Extension baseline is reproduced by
  the [UI-free read capability probe](../final-cut/ui-free-read-capability-probe.md).
- #452–#454 investigate, bridge, and provide the preferred background read path.
- #416 provides an experimental pasteboard observation boundary and decoder;
  its default acquisition state is structured unavailable until an explicit
  headed capture port is configured.
- #493 captures read-only SQLite/WAL/SHM drift relative to a known Framekit
  materialization; storage changes remain ambiguous until a repeated semantic
  mapping is proven.
- #417 normalizes and reconciles provider observations into Timeline IR.
- #418 routes headed FCPXML export as an explicit canonical checkpoint.
- #455 validates the background-read exit criteria on the supported Final Cut version.
- Source-media analyzers remain separate from all timeline-structure providers.
