# Timeline IR to versioned FCPXML

`@framekit/final-cut` provides `compileTimelineIrToFcpxml()` as the Final Cut
edge compiler for the provider-neutral Timeline IR. The runtime remains
editor-independent; this adapter owns the FCPXML version and resource
representation.

## Contract

The compiler accepts a validated `TimelineIr` and a mandatory
`TimelineIrToFcpxmlTarget`. The target carries logical library, event, project,
and sequence identities. FCPXML 1.11 represents the event and project UIDs;
Final Cut assigns the created library and sequence IDs, which require native
catalog readback. Names are descriptive only and are never used as target
identity.

Compilation is deterministic: resources are ordered by logical ID, generated
resource IDs are stable, duplicate resource names receive deterministic
suffixes, and the returned artifact includes a SHA-256 digest plus the logical
resource-to-FCPXML ID map. The result also reports exact/degraded/unsupported
coverage and a target-bound provenance record containing the canonical revision
and Timeline IR digest. The versioned project name and UID include the revision
identity. FCPXML 1.11 has no separate sequence name or UID attributes, so the
reported sequence display name matches the project name. The logical sequence
UID remains in the result and provenance for target matching after native
readback.

Timeline and source coordinates remain exact rational values. The compiler
normalizes equivalent fractions only when writing FCPXML, never through a
floating-point conversion. A local absolute path or `file://` URL is required
for each referenced resource.

When probed media metadata is available, video formats include dimensions and
frame duration, and assets include their source duration, stream counts,
channels, and sample rate. Audio-only assets use Final Cut's
`FFFrameRateUndefined` format. These attributes let Final Cut interpret the media
before it resolves the referenced local files. The sequence format uses the
sequence frame duration and the first video resource's dimensions; a native
import and readback are still required to establish compatibility.

Media resources use `asset` with an `original-media` representation. The spine
contains media occurrences (`asset-clip`) and `gap` story elements. Basic text
titles, music, markers, and captions are attached to a containing primary
element using exact offsets; unsupported spans without an anchor fail closed.
Framekit occurrence IDs are stored in FCPXML metadata where the format permits
them. Marker IDs use the `note` attribute and caption IDs use a `<note>` child,
both prefixed `com.framekit.id:`, because FCPXML 1.11 does not permit metadata
on those elements. The document adapter reads those IDs back. Styled titles,
effects, transitions, fades, unsupported resource kinds,
missing media bindings, and invalid target bindings fail closed with a
structured `FCPXML_*` error instead of being silently dropped.

The output is a new artifact string. It does not overwrite a managed file and
does not claim that the open Final Cut timeline changed. Session materialization
jobs force the versioned destination and pass a `create-only` collision policy
to the explicit background publisher. A background provider must return the
created target identity and canonical Timeline IR before the job can complete.
The separate headed publishing handoff remains distinct and cannot be used as
background evidence.

## Verification

The integration contract checks byte-for-byte determinism, XML escaping, exact
rational timing, explicit target identity, fail-closed unsupported input,
provenance/coverage propagation through the materialization job, and read-back
through `FcpxmlDocumentAdapter`. On a Mac with Final Cut installed, it also
validates representative generated documents against Final Cut's FCPXML 1.11
DTD. A passing DTD check does not prove a headed import or native readback.
