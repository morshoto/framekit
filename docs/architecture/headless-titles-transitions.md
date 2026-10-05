# Headless titles and transitions

Titles and transitions are canonical Timeline IR objects, not NLE-specific
effects or story-line mutations.

`TimelineIrTitle` stores a stable identity, text, exact placement and
duration, a positive connected/overlay lane, and optional typography/layout
intent. Adding a title can extend sequence duration when it is placed after
the existing content, but it never moves a source occurrence.

`TimelineIrTransition` currently supports `cross-dissolve`. It stores a stable
identity, exact positive duration, and the two occurrence identities it joins.
The participants must exist, be adjacent on the same track, meet at one exact
timeline boundary, and each be at least as long as the transition.

Both objects participate in the existing project transaction preview/execute
contract. Their IDs and exact values are included in the persisted project,
revision digest, and transaction diff. Invalid placement fails before the
project store is written. Renderer-specific pixel/audio behavior belongs to
the later renderer provider; this IR layer does not launch or synchronize an
NLE.
