# Timeline IR to versioned FCPXML

`@framekit/final-cut` provides `compileTimelineIrToFcpxml()` as the Final Cut
edge compiler for the provider-neutral Timeline IR. The runtime remains
editor-independent; this adapter owns the FCPXML version and resource
representation.

## Contract

The compiler accepts a validated `TimelineIr` and a mandatory
`TimelineIrToFcpxmlTarget`. The target contains stable Final Cut library,
event, project, and sequence UIDs. Names are descriptive only and are never
used as target identity. The current output version is FCPXML `1.11`.

Compilation is deterministic: resources are ordered by logical ID, generated
resource IDs are stable, duplicate resource names receive deterministic
suffixes, and the returned artifact includes a SHA-256 digest plus the logical
resource-to-FCPXML ID map.

Timeline and source coordinates remain exact rational values. The compiler
normalizes equivalent fractions only when writing FCPXML, never through a
floating-point conversion. A local absolute path or `file://` URL is required
for each referenced resource.

The supported generated spine elements are media occurrences (`asset-clip`)
and `gap` story elements, plus IR markers and captions. Nested occurrences and
gaps are emitted as connected children using exact parent-relative offsets.
Unsupported roles, effects, transitions, titles, fades, resource kinds, missing
media bindings, and invalid target bindings fail closed with a structured
`FCPXML_*` error instead of being silently dropped.

The output is a new artifact string. It does not overwrite a managed file and
does not claim that the open Final Cut timeline changed. Session materialization
jobs force the versioned destination and pass a `create-only` collision policy
to the explicit background publisher. A background provider must return the
created target identity and canonical Timeline IR before the job can complete.
The separate headed publishing handoff remains distinct and cannot be used as
background evidence.

## Verification

The integration contract checks byte-for-byte determinism, XML escaping, exact
rational timing, explicit target identity, fail-closed unsupported input, and
read-back through `FcpxmlDocumentAdapter`.
