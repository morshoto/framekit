# ADR-0009: Non-UI Project and Sequence Selection

- Status: Accepted
- Date: 2026-09-13
- Issue: [#263](https://github.com/morshoto/framekit/issues/263)

## Context

Framekit can discover project and sequence identities from deterministic or
FCPXML-backed providers, but the bundled Final Cut Workflow Extension must not
turn that discovery into an inferred live selection. A request acknowledgement,
a visible project name, or the currently focused Final Cut window cannot prove
that a requested target became active.

## Decision

The bundled Workflow Extension reports project and sequence selection as
unavailable:

```text
editor.projectCatalogRead: false
editor.projectSelection: false
editor.projectSelectionMode: "unavailable"
```

It returns `CAPABILITY_UNAVAILABLE` for both `projects` and `select-project`.
The Node runtime exposes that result through the structured MCP capability
error for `project.list` or `project.select`; it never activates Final Cut,
uses Accessibility UI selection, or pretends that a target became active.

Providers that can select without UI may advertise
`projectSelectionMode: "background-capable"`, but a successful selection must
return all of the following independently:

- the requested stable project and optional sequence IDs;
- the observed active project and sequence IDs after the request; and
- the observed context revision after the request.

`projectSelectionMode: "headed-only"` is reserved for an explicit provider
that requires a headed surface. It does not upgrade canonical timeline
mutation capability and is not a fallback for the bundled bridge.

## Current API evidence

Apple's public Workflow Extension surface provides an `FCPXHost` timeline
proxy. `FCPXTimeline.activeSequence` is a read-only observation, and
`FCPXTimelineObserver` reports active-sequence, playhead, and sequence-range
changes. The public surface documents no library-wide project catalog or
project-activation command:

- [FCPXHost](https://developer.apple.com/documentation/professional-video-applications/fcpxhost)
- [FCPXTimeline](https://developer.apple.com/documentation/professional-video-applications/fcpxtimeline)
- [FCPXTimelineObserver](https://developer.apple.com/documentation/professional-video-applications/fcpxtimelineobserver)

The checked-in host declaration records the same boundary: it exposes
`FCPXHost.timeline`, `FCPXTimeline.activeSequence`, and observer callbacks, but
no library, event enumeration, or activation API. The runtime evidence is
the bridge capability payload above and its `select-project` response:

```text
CAPABILITY_UNAVAILABLE:
Final Cut Workflow Extension does not expose project catalog or selection
```

This decision was checked against Xcode 16.4 and the macOS 15.5 SDK available
to the repository. Final Cut Pro is not installed at `/Applications` in this
workspace, so no headed-native selection claim is made. The opt-in headed gate
remains available for a future provider that supplies the required APIs and
readback evidence.

## Contract and safety boundary

The `project.select` result preserves the catalog's legacy active fields and
adds `requestedTarget`, `observedActiveTarget`, and `observedRevision`.
Missing or malformed revision evidence, duplicate identities, ambiguous
sequences, and target mismatches fail closed. Project selection remains a
target-context transition; it is not canonical timeline mutation, FCPXML
artifact editing, or proof of UI focus.

## Consequences

- Metadata-only live sessions fail fast with actionable structured errors.
- FCPXML and deterministic providers can continue to select their own explicit
  target domains without claiming to change the open Final Cut project.
- A future non-UI implementation must add a provider contract test and an
  opt-in native evidence record before enabling the capability flags.
