# Architecture

Framekit is a local-first editing runtime that owns an editor-independent
project and timeline model. MCP and editor integrations are adapters around
that model:

```text
MCP clients → MCP server ─┐
                           ├→ headless application → runtime contracts → Framekit Project / Timeline IR
CLI ──────────────────────┘          ├── FCPXML document adapter
                                      └── injected headless renderer → verified video
runtime contracts ←────────────── explicit NLE synchronization adapter
```

## Component responsibilities

| Component | Responsibility |
| --- | --- |
| `packages/runtime` | Domain contracts, context, edits, transactions, diffs, and verification. |
| `packages/headless-application` | Transport-neutral headless project, edit, rough-cut, render, and approval workflows. |
| `apps/mcp-server` | MCP transport, schemas, and tool registration. |
| `adapters/final-cut/typescript` | Node-side Final Cut, FCPXML, and provider adapters. |
| `adapters/final-cut/swift-bridge` | The macOS Workflow Extension and native Final Cut boundary. |
| `packages/testkit` | Deterministic in-memory editors, analyzers, and fixtures. |

Dependencies flow toward runtime contracts. Runtime code does not import the
MCP SDK or editor adapters. Headless Framekit projects and their Timeline IR
remain the canonical editing state; editor observations and exported artifacts
do not silently replace that state.
Project persistence uses atomic persisted state updates and revision-guarded
edits. A project revision is separate from a history commit; Git-like commits
are deferred and must not be inferred from revision identifiers.

## Dependency rules

Workspace imports flow toward the runtime contracts. Imports between packages
must use a package's declared public export and the consumer must declare that
workspace dependency directly in its manifest. Relative imports are for files
inside one package. TypeScript path aliases are resolved by the boundary check
and do not grant access to another package's private files. These boundary
rules also apply to type-only imports and exports; production reachability and
cycle checks follow runtime edges.

| Source layer | Allowed workspace dependencies | External packages |
| --- | --- | --- |
| `packages/runtime` (domain and application) | None | Node built-ins only. |
| `packages/headless-application` | Runtime and Final Cut document adapter | Node built-ins only. |
| `packages/testkit` | `packages/runtime` | Node built-ins only. |
| TypeScript adapters | `packages/runtime` | `adapters/final-cut/typescript`: `fast-xml-parser`; headless adapter: Node built-ins only. |
| `apps/mcp-server` | Runtime, headless application, and both TypeScript adapters | `@modelcontextprotocol/sdk`, `zod`, and Node built-ins. |
| `apps/cli` | Final Cut adapter and headless application | Node built-ins only. |

The MCP bootstrap's fixture fallback is the sole `apps/mcp-server` import of
`packages/testkit`; keep it in `apps/mcp-server/src/main.ts`. The CLI declares
its workspace dependencies in `apps/cli/package.json`. The checker does not
permit sibling application imports or private adapter paths.

`@framekit/final-cut` is the default adapter entrypoint. Experimental SQLite,
shadow mutation, pasteboard, unattended-editing, and console-experiment APIs
are available only from `@framekit/final-cut/experimental`; default CLI and MCP
entrypoints must not reach those modules. SQLite inspection and WAL observation
are research-only, non-canonical evidence, not supported editor capabilities.
The standard MCP server does not configure a SQLite provider; `session.observe`
returns `FINAL_CUT_SQLITE_INSPECTION_UNAVAILABLE` by default. Research integrations
must explicitly import the experimental entrypoint and inject an inspection
provider; they must use disposable fixtures and cannot fall back to it from the
production server. SQLite observations do not establish editor revisions or
verify native edits. The boundary checker also rejects
new runtime source dependency cycles. The existing Timeline IR edit/reconcile cycle
between `editing-session.ts` and `drift-reconciliation.ts` is the only
temporary cycle exception; removing it would require extracting shared
validation and reconciliation contracts beyond this gate's scope.

## State, identity, and revisions

Operations bind to stable project and sequence identities,
revision, and the affected media or occurrence identity when applicable.
`TimelineTarget` carries those stable identities and revision; rational
`frameDuration` and timeline times preserve frame-accurate values.
`playheadTime` describes the editor playhead; it is not a substitute for a
stable target or timeline revision. Read-after-write verifies a mutation
against the same target and revision contract. Canonical native rename, trim,
marker, ripple-delete, and gain readback reject collateral changes outside the
supported operation projection and attempt verified recovery. Composite edit
verification compares equivalent rational times by value. A provider advertising
`markerIdentityMode: "editor-assigned"` may return a different ID for a uniquely
added marker; verification still checks its semantics and all other changes. Canonical Final Cut reads reject
live target or revision changes during export; native edits recheck the live
revision after target resolution. The canonical checkpoint is acquired before
native target preparation; if dispatched preparation fails or the revision
changes during it, the checkpoint remains for recovery. The production resolver
uses nonselecting occurrence discovery, validates the discovered identity and
sequence, then checks that selection reports the same identity. The current
Accessibility timeline scan cannot independently observe an occurrence's source
identity. It does not treat the requested Browser identity as an observation.
Native media targeting and canonical source-bound rename, trim, ripple-delete,
and gain remain unavailable until that binding can be proven. Source-bound
operations require an explicit source-observation capability and nonselecting
discovery. They also require an independent selected Inspector observation
bound to the selected identity, with source path and source range matching the
canonical snapshot. The bundled adapter does not yet supply that observation.
The observed Browser source must also match the canonical snapshot's
absolute local path or file URL; a matching basename alone is insufficient.
Equal-named Browser items are distinguishable only when every candidate has an
observed source and exactly one matches the canonical path.
An incomplete Accessibility occurrence scan fails rather than treating its
partial results as a complete or unique match.

The current source-binding decision is **NO-GO** for the bundled adapter:

| Evidence source | Direct observation | Limit for live occurrence binding |
| --- | --- | --- |
| [Workflow Extension timeline API](https://developer.apple.com/documentation/professional-video-applications/interacting-with-the-final-cut-pro-timeline) | Active sequence, selected time range, and playhead; [sequence details](https://developer.apple.com/documentation/professional-video-applications/fcpxsequence) include timing and container information. | The documented timeline interface does not expose an occurrence-to-original-media mapping. Timeline notifications do not establish a complete revision for exported content. |
| Separately authorized [Final Cut FCPXML export](https://support.apple.com/guide/final-cut-pro/use-xml-to-transfer-projects-verdbd66ae/mac) | The exported document can describe project editing decisions and references to resources; an [original media representation](https://developer.apple.com/documentation/professional-video-applications/media-rep) can contain a source URL. | This is an export snapshot, not an identity for an Accessibility element. A target-bound, fresh export and an independently proven mapping would still be required; missing, remote, or proxy-only sources do not establish a local original. |
| Read-only Accessibility scan | The adapter observes accessible timeline elements and their exposed attributes without selecting them. | The current scan does not independently expose their original source. Names, timing, ordering, and a requested Browser item are not proof of the mapping, including when occurrences repeat or names collide. |
| Generated or imported FCPXML | A proposal or import describes intended content. | It is not native readback and cannot prove what the active timeline contains. |

This decision concerns the supported observations assessed here, not a claim
that no future public API can provide the missing evidence. Until a supported,
fresh, target-bound observation establishes the mapping, source-bound native
dispatch remains `CAPABILITY_UNAVAILABLE`; fixture and parser results are not
headed Final Cut acceptance.

Capability loss during target preparation prevents the edit. The
bundled native adapter reports that capability unavailable. If a native edit has
an uncertain outcome or Undo cannot be verified, the canonical provider blocks further previews and
edits. Production native sessions create an exclusive checkpoint under the
configured Framekit state directory before mutation; an unresolved checkpoint
continues to block sessions that use that directory after a restart. Live-mode
MCP processes consult the configured state directory even when their canonical
native provider is disabled. Direct native edits, native jobs, and native publishing routes check for an existing
checkpoint before dispatch, while status, cancellation, and inspection remain
available. Direct `editor.native.edit` and `editor.native.undo` reserve that checkpoint path while
their provider calls are in progress; an unverified result or a failure after native
dispatch retains the reservation. A failure before dispatch releases it. Direct
disposable execute and Undo and disposable native session jobs also reserve the
same path through canonical verification or verified rollback. Native timeline
command executions use the reservation through their native verification. Native
focus, search, selection, and preview calls also reserve it while they can change
UI state; their previews do not write the timeline. Native
media imports also reserve it; an incomplete or partial import keeps the
reservation. Publishing retains its reservation after dispatch, including after
verified readback, because native quiescence remains unproven. The originating
MCP process can separately verify the same pending job only after its dispatch
call returns; it cannot replay the import. Responses after dispatch include the
reservation ID and report that native quiescence is unproven. A different process
cannot claim that reservation, and a direct publish cannot transfer its
reservation to a subsequently created recovery job. Until a supported recovery path exists, even a verified publish
therefore leaves subsequent guarded operations blocked. Configured session
materialization reserves the checkpoint at the provider boundary; if acquisition
fails, it records that the provider was not called. Before invoking the provider,
the job persists a `dispatch-intent` phase; this is not proof the call occurred.
The reservation can be released when local code positively establishes that
neither the provider nor its tracking wrapper was invoked. Once a publish or materialization provider is invoked, a
missing dispatch callback is not evidence that no dispatch occurred. The
disabled built-in publisher, missing inert live-state or readback configuration,
and an unconfigured built-in background materializer are checked locally before
provider invocation. Staged materialization requests also undergo the same pure
validation used by the built-in provider before reservation. A retry is offered
only when the preflight result permits it. Other invoked-provider outcomes remain
conservatively reserved. The reservation remains and automatic retry is
disabled even if canonical readback matches, until native quiescence can be
established. Other direct operations and
background jobs still use entry checks, so shared exclusion
across all native routes is not proven. Native command acceptance does not prove
later native quiescence. Restarting or changing state directories does not establish that recovery succeeded. There
is no automatic checkpoint reset or supported recovery flow yet. The read-only
`editor.native.recovery.inspect` MCP tool reports a canonical checkpoint or a
native-operation reservation in the configured state directory without inventing
a target, contacting Final Cut, or clearing it; a
clear result is point-in-time and does not establish recovery or the state of
other directories. `editor.native.recovery.evidence.inspect` separately reads native
v2, v3 and v4 reservation identity and any durable sender evidence without
creating a transaction lock. It reports a point-in-time observation, unavailable
recovery eligibility, and unproven native quiescence. Job and dispatch IDs are
recorded reservation fields; no independent job or receiver correlation is
verified. New materialization reservations record the requested target,
versioned destination, artifact and desired digests and a locally generated
dispatch ID. Publish jobs with an explicit library path record that requested
path, artifact digest and local dispatch ID. Other publish requests retain the
legacy reservation format. Intent fields do not verify the actual target or
dispatch. Retained-reservation diagnostics report possible dispatch, missing
evidence and the safe actions of inspection and retention. Missing, malformed,
conflicting or concurrently changing evidence is unknown; an active marker
may instead reflect an interrupted sender. Direct native calls retain their
reservations after invoking an enabled provider, even if it reports success;
its return does not prove that no deferred native action remains. An unmodified
disabled built-in adapter's operations can be rejected without invoking it. Disposable
native jobs similarly retain reservations after entering their tracker or workflow.
No observation authorizes release, dispatch or recovery. Old writers do not participate in the newer lock protocol,
so inspection cannot establish a globally consistent view or exclude a later
write. `editor.native.recovery.preview` requires the inspected
checkpoint ID, matching target IDs, and explicit headed-read confirmation; it
compares a canonical snapshot with the recorded digests. Its point-in-time
result does not prove that a native operation has stopped and never clears the
checkpoint. An Undo checkpoint also records the digest of the state it was
intended to restore. Canonical
revision tokens are scoped to the provider session and change when the live revision changes. Where live project
selection is supported, subsequent canonical reads remain bound to the selected
project and sequence until an explicit new selection succeeds. Passive MCP
capability and routing inspection does not initiate a headed snapshot export;
an unprobed canonical provider reports its snapshot capability unavailable.
Validated evidence may be reused only while the live target and revision match;
it does not authorize a later headed context or change read. A confirmed
canonical read shares its exported snapshot only within that request; a later
request exports again. Matching live revisions do not prove that all timeline
changes were observed or that a snapshot remains current after export.
Supported FCPXML dialogue subroles are retained as `nativeAudioRole` on
canonical clips and editing-session occurrences, including during materialization
and publish readback comparison. Unsupported roles on audio elements fail closed.

An incremental result must match its target and revision cursor. Concurrency
conflicts and stale-write errors, ambiguous or incomplete observations, and
unavailable providers require a fresh canonical
read or a structured failure. Metadata-only observations cannot be promoted to
canonical changes, and provider changes do not upgrade the evidence guarantee.
`timeline.changes` and `context.changes` return changes in deterministic order,
with operation-specific before and after values and provider and backend provenance.

## Provider and evidence boundaries

| Evidence surface | What it establishes | What it does not establish |
| --- | --- | --- |
| Deterministic fixture | Behavior against a controlled in-memory editor. | Final Cut state or a native edit. |
| FCPXML artifact | Read, write, or verify the selected interchange artifact. | Mutation of the currently open Final Cut project. |
| Metadata-only bridge | Observed editor identity, project metadata, playhead, range, or events that the bridge exposes. | A complete canonical timeline snapshot or timeline-write capability. |
| Canonical provider | The exact read or write capabilities the provider explicitly advertises. | Any capability it does not advertise. |
| Headed-native verification | A separately authorized operation with exact-target readback and restoration evidence. | Proof for a different project, revision, extension, or operation. |

`connection.status`, `editor.inspect`, and `editing.route` report the selected
backend and operation-level capability. A missing capability must fail closed
with an explicit `CAPABILITY_UNAVAILABLE` result. Framekit does not silently fall back to Final
Cut, an external renderer, or a weaker observation and describe it as stronger
evidence.

`editor.native.media.search` treats query text literally. Queries containing
`*` or `?` return a structured unsupported error before Browser UI access.
If standalone Browser search automation exceeds its deadline, it reports
`FINAL_CUT_NATIVE_SEARCH_TIMEOUT`; import discovery retains its separate timeout.

MCP Skills use the generic `skill.list`, `skill.inspect`, `skill.preview`, and
`skill.execute` lifecycle. An execution must use the selected candidate and
the exact preview target and revision; verification and rollback status remain
part of the result.

## Headless and native editing

The normal Framekit-owned editing path is headless. It does not require Final
Cut Pro to be installed, open, or frontmost. It works when Final Cut Pro is
closed or when Final Cut Pro is not installed. The bundled Workflow Extension provides metadata
only unless a configured provider advertises more. A failed headless operation
has no implicit headed-native fallback or foreground activation.

The artifact-first workflow uses separate capability and evidence boundaries:

| Surface | Gate and result |
| --- | --- |
| Headless editing | A configured Framekit project store and supported, revision-bound operation; no native reservation is required. |
| Artifact generation | The requested compiler or renderer must support the project and source media; generated FCPXML and verified video are local artifacts. |
| Manual handoff | A person may review and separately arrange a handoff; generating an artifact does not establish that Final Cut received or accepted it. |
| Native observation | A separately available native provider must independently identify the target and report sufficient current state. |
| Native mutation | The native operation requires its own target, authorization, recovery and verification prerequisites; an uncertain reservation continues to block guarded native work. |

An unavailable native surface does not disable a side-effect-free headless
operation. Evidence from one row does not establish the result of another.

FFmpeg headless renders normalize audio to AAC at 48 kHz mono. Verification
checks this emitted format while preserving registered source metadata; other
renderer backends are checked against their source audio metadata.

For `ripple-delete`, preview rejects ranges outside the active sequence bounds
before issuing a preview token. The structured error reports the requested
range and observed timeline bounds, including for a negative start.

Native UI edits require an explicit headed path and a separately approved
operation. Bind the preview to the exact project, sequence, occurrence, and
revision; verify the intended target and foreground state before execution;
require canonical readback; and verify Undo or rollback. If a required capability,
identity, revision, or readback is missing, stop without claiming success.
Native readiness reports `targetBound` only for a selected occurrence with a
stable identity and live project, sequence, and revision. An occurrence index
alone is not bound-target proof. Background inspection must not click, type, activate Final Cut, or select a
project through the UI. A locked native console is a blocker; do not retry the
import or overwrite the target without a fresh approved operation.
`context.inspect` is passive by default. An explicitly authorized headed
context read uses `confirmHeadedRead` and an `expectedTarget` containing the
project and sequence IDs; a mismatch fails before the export. This confirmation
does not itself establish user authorization or provide atomic target binding.
Direct `project.inspect`, `timeline.inspect`, `timeline.semantic.inspect`, and
`editor.native.recovery.preview` calls use the same confirmation and target
fields when they require a headed canonical snapshot. Missing confirmation or a mismatched target fails before
export, and the active IDs are checked again after the read.

`EditingSession` keeps desired edits provider-neutral and bound to a versioned
editable project. Reconcile changes against the original project before
materializing or publishing; the source must not be flattened into canonical
state. A canonical resync or an explicit conflict resolution is required when
the observed revision is stale. Background Final Cut inspection does not use
System Events or UI automation to select a project; an unavailable provider
remains unavailable. The project, source artifact, and active editor state
retain separate identities and evidence guarantees.
Project catalog provenance reports selection as available when the live provider
exposes a supported selection mode, or for active-target-only rebind when a
complete cached canonical snapshot still matches the live target and revision.
That rebind does not activate a project or export a snapshot. Background
catalog access alone does not make a project selectable.

FCPXML editing is an explicit artifact operation. Publishing an artifact to a
new `.fcpbundle` is a separate operation with an explicit destination and
confirmation; a dispatch acknowledgment is not proof that Final Cut imported
it. Verified publish jobs can be recovered after restart; handoff readiness
revalidates the saved library, event, project, and sequence against the live
target before reporting them as rebound. Pending publish status may include a `delivery` dispatch acknowledgment;
that evidence remains unverified and does not include a created target or
verified result. An unacknowledged import attempt retains its `dispatchError`
even if a later verification produces a different error. A pending job may
report an `observedTarget` after matching live identity; that observation alone
is not semantic verification. A second,
explicit confirmation on the same job authorizes
headed semantic readback; direct publishing requires separate creation and
readback confirmation fields. A reservation with an attempted or unknown
dispatch cannot be reclaimed just because its owner exited or the library has
not appeared. The publisher retains the dispatched FCPXML across process
restarts while the import is unresolved and removes it after successful
verification. Native acceptance requires matching project and sequence
readback. `editor.inspect` reports `artifactPublishDispatchGuarantee`
as `requested-unverified`; the publishing capability's `native-verified`
guarantee describes the evidence required for a completed handoff, not the
result of its dispatch step.

## Persistence and synchronization

Framekit-owned projects persist provider-neutral Timeline IR and revision history.
External editor state is synchronized through an adapter and reconciled
against the bound revision before applying edits. A conflict, stale revision,
or uncertain source state blocks materialization and publication until the
caller obtains a new observation or resolves the conflict. Background library
and SQLite observations retain their provider provenance and do not become a
canonical timeline solely because they contain familiar fields.

Application services depend on narrow storage contracts. `ProjectStore` is
implemented by `FramekitProjectStore`, which remains the default schema-versioned
JSON adapter and preserves the existing project path, atomic writes, and revision
checks. `TransactionStore` is implemented by the in-memory transaction store
used by the runtime. Session persistence and semantic media indexing keep
separate contracts and adapters; the semantic media index already follows this
pattern, while session persistence can adopt it in its own change without
changing project storage.

### Analysis provider identity

Analyzer provenance can include a model identity and a configuration digest.
Speech binding rejects conflicting configured provider, version, model or
configuration identities; source cache compatibility checks compare all those
fields. Command speech/audio providers capture their execution environment,
use that same environment for subprocesses, and fingerprint the command path,
environment, declared version and VAD requirement. Only the digest is returned,
not raw environment values. Executable/model data at unchanged paths must have
a newly pinned provider version when their contents change. Provider identity
does not establish native source binding or acceptance.

### Local analyzer source verification

Command analyzers stream a SHA-256 check before provider execution and compare
any supplied source digest (hex or `sha256:`-prefixed hex) with the actual
source bytes. A mismatch returns `ANALYZER_SOURCE_CHANGED` before starting the
provider. Successful provider output is accepted only after a second content
check; a changed or unreadable source invalidates that output. This check
verifies local source content, not the independent binding between a native
Final Cut occurrence and that source. Sources without a supplied digest are
checked for changes during analysis but do not gain cross-run identity evidence.

Audio analysis reports `signalScope: source` by default. An occurrence measurement
request includes the exact `occurrenceId`; an occurrence-aware provider must echo
that ID and return `signalScope: occurrence` with its measured signal. A
mismatched occurrence is rejected. Source-file loudness cannot authorize or
verify an occurrence gain change: normalization reports an unavailable
occurrence measurement, and a source-only post-write response causes verified
rollback rather than an output-loudness claim. Reusable source analysis and
occurrence/output measurements remain distinct.
