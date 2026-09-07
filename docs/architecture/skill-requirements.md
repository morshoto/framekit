# Skill requirement resolution

Skill manifests declare editor capabilities, analyzer capabilities, and
semantic operations as a boolean requirement tree. `allOf` requires every
child; `anyOf` selects the first satisfied child in declaration order. The
resolver runs against the active `RuntimeCapabilities` and returns the Skill
identity, selected path, exact missing leaves, stable reason codes, backend,
and optional editor/revision context.

Semantic operations are explicit. `editor.timelineWrite` does not imply that
every operation is supported; adapters must advertise each operation they can
guarantee through `editor.semanticOperations`. Missing, malformed, or unknown
requirements fail closed. In particular, a metadata-only live session cannot
resolve a mutation-dependent Skill merely because it can report an observed
timeline.

Requirement resolution is a precondition for planning and execution. The MCP
layer should expose the structured result, but must not duplicate the resolver's
policy.
