# Background Timeline Read Gate: Final Cut Pro 10.7.1

Decision recorded: 2026-10-02
Compatibility target: Final Cut Pro 10.7.1, build 410082; ProExtensionHost 41000.8.16

## Decision

**NO-GO for a private-runtime background timeline provider in the v0.1.15
release path.** Do not proceed with #453 or route normal timeline inspection
through such a provider in #454. This is a release suitability decision, not a
claim that no internal API can expose timeline data. No target-version private
runtime bridge has demonstrated complete coverage, safe background reads, or a
maintainable install and update path.

The supported-surface probe from #423 is reproducible on the target. It reports
`metadata-only`: read-only Apple Events identify projects and sequences and
return sequence metadata, but declare no sequence occurrence collection. The
Workflow Extension reports project/sequence and playhead/range metadata. Its
revision is a process-local counter advanced by observer callbacks, not a
source-bound revision for a complete timeline snapshot. Framekit must keep
`canonicalDocument.read` unavailable on this path.

## Field coverage

Coverage below is against Framekit's complete `ProjectSnapshot` contract, not
against fields a private API might expose in a different Final Cut version.

| Required surface | Target-version evidence | Coverage |
| --- | --- | --- |
| Active project and sequence identity | Apple Event project ID and sequence ID; Workflow Extension stable UID metadata | Partial metadata; no demonstrated background target-resolution run |
| Timeline occurrences and stable occurrence IDs | No occurrence collection in the read-only Apple Event dictionary; no target-version private bridge | Unknown / unavailable |
| Source/resource bindings | No per-occurrence bindings in the supported surface; no target-version private bridge | Unknown / unavailable |
| Exact timeline and source timing | Apple Events expose sequence start, duration, and frame duration only | Partial; occurrence/source timing unavailable |
| Roles and lanes | No supported per-occurrence role/lane fields | Unknown / unavailable |
| Primary/connected storyline relationships | No supported sequence occurrence graph | Unknown / unavailable |
| Markers, captions, titles, transitions, compounds, multicam, effects | No complete target-version occurrence model was demonstrated | Unknown / unavailable |
| Revision/freshness | Workflow Extension observer counter reflects observed callbacks in one process | Partial metadata; not source-bound to a complete timeline |
| Repeated background reads and external-edit reconciliation | No private-runtime provider exists to exercise this behavior | Not demonstrated |

Unknown fields stay unknown. The probe does not infer an empty timeline, and
neither metadata nor a detected private symbol can enable canonical reads.

## Candidate and safety assessment

| Option | Result for this release |
| --- | --- |
| Direct private Objective-C/Flexo access | NO-GO: no reproducible 10.7.1 bridge or complete field map has been demonstrated; class/selector behavior would be version-bound and undocumented. |
| Minimal injected bridge | NO-GO: no safe, target-version proof exists. The required in-process hosting, crash isolation, signing, and update behavior remain unvalidated. |
| Existing SpliceKit bridge | NO-GO: its documented approach patches and re-signs a copied Final Cut application and uses private runtime interfaces. Its published API reference targets Final Cut Pro 11.1, not this 10.7.1 compatibility target. It does not establish safe installation, 10.7.1 compatibility, or Framekit's complete snapshot/freshness contract. See [SpliceKit](https://github.com/elliotttate/SpliceKit), [API reference](https://github.com/elliotttate/SpliceKit/blob/main/docs/FCP_API_REFERENCE.md), and [application internals](https://github.com/elliotttate/SpliceKit/blob/main/docs/FCP_APPLICATION_INTERNALS.md). |
| `.fcpbundle` / SQLite | Observation only: existing investigation found partial project/media inventory and storage-drift signals, but no complete target-bound ordered occurrence graph or source-bound editor revision. |
| Workflow Extension / Apple Events | Retain as metadata/live-state layer; current capabilities remain non-canonical. |
| Pasteboard experiment #416 | Insufficient fallback: current #439 work adds a decoder for supplied pasteboard data, not a passive capture path. A `Select All -> Copy` capture requires timeline selection and clipboard mutation, so it fails the v0.1.15 normal-read criteria. Keep it experimental and non-canonical. |
| Explicit FCPXML | Retain for user-requested verification/interchange and headed canonical reads; it is not an automatic normal-read fallback. |

No target-version private bridge was injected or launched for this gate. That
would require running unvalidated code inside Final Cut or replacing its
signature on a copied application; neither route currently has the safety and
compatibility controls needed for this release. Accordingly, this NO-GO does
not assert what an instrumented private runtime could enumerate. It records
that the available evidence cannot support shipping or advertising that path.

## Milestone disposition

The #416 pasteboard experiment cannot satisfy the same background-read exit
criteria because it can require focus, selection changes, and clipboard
mutation. No safe fallback meets all v0.1.15 criteria. Therefore the milestone
is **BLOCKED**; do not implement #453/#454 as a forced private-runtime path,
do not close #455, and do not claim milestone completion.

Keep #455 open with this exact blocker: *Final Cut Pro 10.7.1 has no
target-version private-runtime bridge validated for complete target-bound
timeline structure and source-bound freshness; the existing #416/#439
pasteboard fallback requires UI selection/copy and clipboard side effects, so
it does not meet the background-read exit criteria. Live background QA cannot
run until a safe compatible provider exists.*

The reproducible supported-surface baseline and its sanitized target fixture
are documented in [the UI-free read capability probe](../final-cut/ui-free-read-capability-probe.md).
