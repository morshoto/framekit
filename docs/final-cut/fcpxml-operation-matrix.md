# FCPXML artifact operation matrix

This matrix describes the safe subset implemented by the FCPXML document
adapter. It applies to the managed artifact configured with
`FRAMEKIT_FCPXML_PATH`; it does not expand the live Final Cut provider.

## Supported operations

| Operation | FCPXML representation | Safety boundary |
| --- | --- | --- |
| `rename-clip` | Existing clip `name` attribute | Existing occurrence only |
| `trim-clip` | Clip `duration` | Source range must remain within the referenced media |
| `set-gain` | `adjust-volume amount` | Finite dB value |
| `add-marker` | Spine `marker` | Explicit timeline ID |
| `timeline.media.add` | New `asset-clip` or `audio` resource reference | Known media resource, compatible role, valid lane and source range |
| `timeline.media.move` | Clip `offset` and `lane` | Primary-storyline and parent-relative moves only |
| `timeline.media.replace` | Existing clip `ref` and duration | Compatible media kind and source range |
| `timeline.media.remove` | Remove an existing occurrence | Removes the occurrence and its anchored descendants |
| `ripple-delete` | Shift, trim, or remove direct spine elements | Source-preserving edge edits; nested story elements and transitions fail closed |
| `timeline.picture-in-picture.add` | Connected `asset-clip`, transform and crop adjustments | Video media, known anchor, unambiguous transform/crop; solid frames are unavailable |
| `timeline.audio.fades` | Nested `adjust-volume` `param` fade elements | Fade durations must fit the clip |
| `timeline.audio.attach` | Anchored `audio` occurrence | Known audio media, target occurrence, and fitting source range |
| `timeline.audio.mix` | Audio gain and/or nested fades | Audio occurrence only; values must fit the clip |
| `timeline.title.add` | `title ref="effect-id"` and text child | Effect must have a stable Final Cut `uid` and a non-primary lane |
| `timeline.transition.add` | `transition` plus `filter-video ref="effect-id"` | Stable effect identity and adjacent primary clips |

Title and transition resources are exposed as `EditorAsset` values with IDs of
the form `fcpxml:effect:<uid>`. Their `metadata.localId` retains the document's
resource ID, while `metadata.identity` retains the stable template identity.
Framekit-managed transition relationship attributes preserve the before/after
occurrence IDs because the FCPXML transition element has no standard
occurrence-reference attributes.

## Unsupported or lossy operations

The adapter returns `CAPABILITY_UNAVAILABLE` before claiming success for
operations outside the matrix. This includes:

- `media.import`, because an artifact edit cannot safely invent a source URL,
  resource identity, or source digest;
- `timeline.mask.add`, including normalized rectangle, ellipse, draw, and
  shape masks, because the available normalized model does not identify one
  lossless FCPXML mask representation;
- solid-frame picture-in-picture, nested or transition-containing ripple
  deletes, and unsupported effect or color-correction operations.

Malformed documents, missing resources, invalid source ranges, ambiguous
anchors, stale revisions, and failed verification are errors. Transaction
mutation restores the in-memory artifact state on failure, and persistence
uses a temporary file followed by an atomic rename.

## Lifecycle and evidence

Every supported artifact operation is exercised through the applicable
preview/execute path, read-after-write snapshot, diff, verification, stale
revision guard, and rollback path. Preview restores the in-memory document and
does not write the file. Execute updates only the managed FCPXML artifact.

This is deterministic FCPXML interchange evidence. It does not prove a live
Final Cut timeline change, native UI placement, native duration, or native Undo.
Importing a verified artifact into Final Cut is a separate, explicitly
confirmed workflow described in [Final Cut integration](./README.md).

The adapter preserves existing resources and ordered XML nodes, writes timing
as reduced rational seconds, and leaves native Final Cut library internals
(`.fcpbundle` databases) out of scope.
