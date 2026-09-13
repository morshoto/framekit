# Final Cut Provider Boundaries

Issue: [#248](https://github.com/morshoto/framekit/issues/248)

Status: Design contract

Framekit treats Final Cut inspection, canonical timeline evidence, and native UI
mutation as separate provider responsibilities. A provider may contribute
observations to a composed session, but a weaker observation never upgrades the
guarantee of another provider.

## Provider responsibilities

| Provider surface | Implementation seam | Safe responsibility | Guarantee | UI requirement |
| --- | --- | --- | --- | --- |
| Background library inspection | `FinalCutBackgroundCatalogProvider` and the live `projects` seam | Read library, event, project, and sequence metadata with stable IDs when exposed | `observed` / `metadata-only` | None; no Final Cut activation or focus |
| Canonical timeline snapshot | `FinalCutCanonicalSnapshotSource` and `FinalCutCanonicalNativeProvider.readProject` | Read a complete, target-bound timeline snapshot for canonical inspection and verification | `canonical-read` | Headed `File > Export XML` is required by the current provider |
| Native UI writes | `NativeFinalCutEditor` and the native mutation ports | Perform guarded Accessibility edits and verify the resulting native state | `native-verified` | Frontmost Final Cut, timeline focus, target checks, readback, revision, and Undo |

The Workflow Extension socket is a supporting live-metadata surface. Its state,
playhead, range, revision, and change events are observed metadata. The current
bridge advertises `projectCatalogRead: false`, so the background catalog
interface is intentionally available for a provider when supported without
claiming that the bundled bridge already supplies a catalog.

The explicit `FRAMEKIT_FCPXML_PATH` provider is also separate. It reads and
edits a `fcpxml-artifact` with an `artifact-write` guarantee; it does not read or
change the open Final Cut timeline and does not become canonical-live or
native-verified evidence.

## Routing rules

| MCP operation | Preferred provider | Required evidence | Closed boundary |
| --- | --- | --- | --- |
| `project.list` | Background catalog, when its capability is advertised | Stable catalog identities and observed provenance | It must not invoke canonical Export XML just to construct a catalog |
| `project.inspect` | Canonical snapshot provider | `canonicalDocument.read` and a complete target-bound snapshot | Background metadata cannot satisfy canonical inspection |
| `project.select` | An explicitly advertised selection provider | `projectSelection` plus target validation | Background catalog listing alone cannot select or focus a project |
| `editing.route` for open-timeline edits | Canonical or native provider selected for the requested operation | The operation's canonical or native capability descriptor | `metadata-only` capabilities fail with `CAPABILITY_UNAVAILABLE` |
| `artifact.edit` | Explicit FCPXML artifact provider | `fcpxml-artifact` source, revision, and digest | Artifact edits never claim to modify the open timeline |

`editor.inspect` reports the provider backend, the strongest guarantee, and an
actionable unavailable reason in the versioned capability families. The modes
`metadata-only`, `canonical-live`, `native-write`, and `fcpxml-artifact` remain
distinct. In particular, observed background or live metadata must never be
advertised as a canonical timeline snapshot, and routing must never choose a
canonical or native write path from metadata-only capabilities.

## Safety boundaries

Background inspection is read-only. Its provider must not import, edit, select,
focus, activate, or export through a dialog. It must not use System Events UI
scripting, clicks, keystrokes, Accessibility focus, or project selection. If a
field is unsupported, the provider returns an actionable unavailable or partial
metadata result rather than guessing a canonical value.

Canonical reads require a complete project and sequence target with stable
media and occurrence identities, rational coordinates, roles, relationships,
and a source-bound revision. A missing or changing target fails closed.

When the canonical snapshot and guarded mutation providers are composed with
revision-guarded mutation, read-after-write, and rollback, the capability
contract may expose `canonical-write`. A direct native UI operation instead
exposes `native-verified`; neither guarantee is implied by observed metadata.

Native UI writes retain the existing safety sequence: explicit target and base
revision, preview, frontmost and timeline-focus preflight, Accessibility
mutation, post-write readback, revision verification, and verified native Undo
or rollback. Removing a frontmost check from a UI operation does not turn it
into a background provider.

No provider reads or writes undocumented `.fcpbundle` SQLite internals. Such
stores cannot establish a supported, complete, target-bound Final Cut contract.

## Related decisions

- [Backend selection](./backend-selection.md) describes composed provider choice.
- [Capability model](./capability-model.md) defines operation descriptors and
  evidence guarantees.
- [Non-UI timeline snapshot investigation](./non-ui-timeline-snapshot-investigation.md)
  records why partial metadata remains metadata-only.
- [Native write and Undo investigation](../final-cut/native-write-undo-investigation.md)
  records the headed safety boundary.
- [Background artifact publishing](./artifact-publishing.md) describes the
  separate artifact handoff into Final Cut.
