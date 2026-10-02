# UI-Free Final Cut Read Capability Probe

Run the supported-surface probe after installing or updating Final Cut Pro:

```sh
pnpm run probe:final-cut-read
```

It reads the installed app and bundled `ProExtensionHost` plist metadata, the
app's Apple Event dictionary through `sdef`, and Framekit's checked-in
`ProExtensionHostShim` and Workflow Extension declarations. It does not launch
or focus Final Cut Pro, send Apple Events to it, change selection or playhead,
touch the clipboard, save a project, or export FCPXML. The probe does not scan
the installed framework binary for private Objective-C/Flexo symbols.

Output is JSON with the Final Cut version/build, bundled host version, exact
Apple Event suite/command/class/property/element names and codes, the
read-only bridge declarations, Workflow Extension state fields and advertised
metadata-only capabilities, and an advisory coverage classification. Pass a
non-default app location with `--app /path/to/Final\ Cut\ Pro.app`.
The checked-in host header also declares `movePlayheadTo`; the inventory records
that selector as potentially mutating, and the probe never invokes it.

The classifier may report `metadata-only`, `complete-direct-snapshot-candidate`,
or `unsupported/unknown`. A candidate only means the declarations appear to
cover read-only identity, occurrence, rational timing, resource, role,
storyline, and revision fields under the inspected read-only object model.
`canonicalCapabilityPromoted` is always false;
target identity, collection completeness, exact occurrence timing, resource
binding, storyline coverage, and source-bound freshness still require empirical
validation before Framekit can advertise `canonicalDocument.read`.
The probe never promotes `canonicalDocument.read`.

The sanitized evidence captured for Final Cut Pro 10.7.1 is
[`final-cut-supported-read-probe-10.7.1.json`](../../tests/fixtures/final-cut-supported-read-probe-10.7.1.json).
It records one read-only library-inspection access group and the `get` command.
The dictionary exposes project/sequence identity and their relationship, plus
sequence-level timing metadata, but does not declare a target-bound occurrence
collection, exact occurrence/source timing, per-occurrence resource bindings
and roles, storyline relationships, or a source-bound revision.
The Workflow Extension reports a process-local counter for active-sequence,
playhead, and sequence-range observer callbacks; the probe records that signal
separately and does not treat it as a source-bound revision for complete
timeline structure. The current Apple Event object-model result is therefore
`metadata-only`.

This probe is the reproducible supported-API baseline for the layered readback
architecture in [#415](https://github.com/morshoto/framekit/issues/415) and the
private-runtime Go/No-Go investigation in
[#452](https://github.com/morshoto/framekit/issues/452). It is advisory and
cannot enable a provider by detecting a symbol or command name.
