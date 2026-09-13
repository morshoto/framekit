# Background Final Cut Library Inspection

Framekit's background library provider reads Final Cut library metadata through
the read-only `com.apple.FinalCut.library.inspection` Apple Event access group.
The provider uses direct Apple Events against `com.apple.FinalCut`; it does not
use System Events, Accessibility scripting, menus, dialogs, keystrokes, focus,
or project selection.

## Returned data

The parser preserves the hierarchy exposed by the current Final Cut scripting
dictionary:

`library -> event -> project -> sequence`

Libraries, events, projects, and sequences retain their names and stable IDs.
Sequence `startTime`, `duration`, and `frameDuration` are normalized to
Framekit rational values with string `value` and `timescale` fields. If a
field is not supported or cannot be read, the result retains the sequence and
returns a structured unavailable field with its path and reason. It never
substitutes seconds, zero, or a guessed frame rate.

The existing `project.list` contract receives the safely discoverable project
and sequence IDs. The richer provider result remains available to callers that
need library or event context. Catalog data is observed metadata only, and
project selection remains unavailable until a separate supported provider can
prove it without changing application focus.
This provider is therefore reported as a metadata-only observation surface,
never as canonical timeline evidence.

## Failure states

The provider reports `available`, `partial`, `unavailable`, or `error` results.
Apple Event failures include an actionable
`FINAL_CUT_LIBRARY_INSPECTION_UNAVAILABLE` code; permission failures explain
that Automation permission is required. Invalid or unsupported media-time
records retain their field path and use a structured parser error.

`project.list` serializes provider failures without upgrading them to canonical
timeline evidence. Background library metadata must not be used as a complete
timeline snapshot, canonical read, or native write guarantee.

## Version evidence

The current dictionary was inspected on Final Cut Pro 10.7.1. That version
declares the read-only library inspection access group and the library, event,
project, sequence, and media-time records used by this provider. Framekit does
not claim that older versions support this surface: a deployment must verify
that the same access group and object properties are present before enabling
the provider.

Deterministic parser and protocol tests cover complete, partial, unavailable,
and malformed responses. A headed validation run is opt-in because it requires
an installed Final Cut library and Automation permission; the provider itself
does not activate or focus Final Cut Pro.
