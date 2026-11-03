# ADR 0676: Native recovery proof and legacy exclusion

Status: **B — deferred for the current production integration**, 2026-11-04.
Related: [#676](https://github.com/morshoto/framekit/issues/676), [#670](https://github.com/morshoto/framekit/issues/670), [#673](https://github.com/morshoto/framekit/pull/673).

## Decision and scope

Do not enable production reservation recovery or reclaim an interrupted transaction lock. The inspected Final Cut Pro 10.7.1 interfaces do not establish an operation-specific, durable terminal receipt with a no-delayed-execution guarantee; the existing verifier accepts injected evidence but has no authenticated production source. This is a finding about the interfaces reviewed, not a proof that no other supported interface exists. A future receiver must own or enforce execution, maintain a durable operation journal, and provide the contract below. A separately trusted, target-bound canonical reader and a migration excluding every legacy writer and dispatch participant are also prerequisites. No native dispatch was performed for this decision.

## Receiver feasibility

The six columns ask whether the documented interface supplies (1) a receiver-recognized operation ID, (2) receiver start, (3) operation-specific terminal completion, (4) exclusion of late execution after timeout, (5) durable evidence across restart, and (6) independent target-bound canonical readback. **Unverified** means the reviewed documentation does not establish the guarantee; **no** refers only to the described interface, not all possible APIs.

| Interface | ID | Start | Terminal | No late execution | Restart | Canonical readback |
| --- | --- | --- | --- | --- | --- | --- |
| [Open Document / FCPXML](https://developer.apple.com/documentation/professional-video-applications/sending-data-programmatically-to-final-cut-pro) | Unverified | Unverified | Unverified | Unverified | Unverified | Separate export; correlation unverified |
| [Workflow Extension timeline observer](https://developer.apple.com/documentation/professional-video-applications/interacting-with-the-final-cut-pro-timeline) | No import ID described | No import start described | Timeline changes, not import terminal | Unverified | Unverified | Active timeline metadata; complete canonical snapshot unverified |
| AppleScript/JXA Open Document | Unverified | Unverified | Reply is not established as a receipt | Unverified | Unverified | Separate target-bound export unverified |
| Accessibility/UI observation | No import ID established | UI state only | Unverified | Unverified | Unverified | UI observation is not canonical readback |
| [Drag and drop](https://developer.apple.com/documentation/professional-video-applications/supporting-drag-and-drop-for-data-sent-to-final-cut-pro) | No operation protocol described | Data provision only | Unverified | Unverified | Unverified | Separate export; correlation unverified |
| [Share/export](https://developer.apple.com/library/archive/documentation/FinalCutProX/Conceptual/FinalCutProXWorkflowsGuide/Exporting/Exporting.html) | No correlation to earlier import established | Export only | Export only | Import quiescence unverified | Import evidence unverified | Separate observation; target, completeness and correlation unverified |
| Current Framekit Swift bridge | Local request only | Open attempt only | Returns dispatched, not imported | Unverified | No receiver journal | Canonical capability unavailable |

The installed 10.7.1 scripting dictionary and extension symbols were inspected read-only in #673. Neither absence in that inspection nor an Apple event reply proves quiescence. No non-destructive local probe can establish the required no-replay guarantee without a documented receiver contract or executing a receiver operation; dispatch is outside the approved scope. Additional official receiver documentation or a supported receiver with a durable journal would allow a meaningful test; an approved disposable headed run would then validate the integrated implementation, not substitute for the contract.

## Proposed receiver contract (not implemented)

A receiver must authenticate its stable installation/instance identity and expose a versioned, authenticated durable journal. An operation is identified by a unique reservation ID, dispatch ID and job ID; the receiver must atomically bind those IDs to route, immutable artifact digest, canonical target identity, receiver identity and protocol version before accepting execution. Reusing an ID with any changed binding must be rejected. An authenticated query after sender and receiver restarts must return the same immutable record or an explicit unknown result, never fabricate completion.

A terminal receipt must contain: schema and journal epoch; unique receipt ID; receiver identity and authentication proof/key ID; reservation, dispatch and job IDs; route; artifact digest; exact target identity; terminal outcome; and durable terminal sequence/version. It must certify that this exact operation is terminal and that the receiver and every delegated executor cannot subsequently start, resume, or replay it. The journal must persist the terminal decision before returning it, survive the documented crash/restart model, and reject replay independently of the sender. Authentication, journal durability, delegation and no-replay are properties to establish from the implementation and its platform guarantees, not values asserted by an untrusted boolean.

Suggested state transitions: `intent -> accepted -> running -> terminal(completed|failed|cancelled)`; a receiver may durably reject an intent before execution. Timeout or sender crash changes only the sender's knowledge to **unknown**, never the receiver state. Repeated identical requests query the same operation; they must not cause a second execution. A terminal state is monotonic across restart and cannot transition back to runnable. Missing, unauthenticated, inconsistent, rolled-back, or nonterminal evidence leaves the reservation intact. Recovery rechecks the same terminal receipt after independent readback under an effective exclusion mechanism; it records matching proof before idempotent release. A failed or cancelled receipt alone does not establish restoration.

The current #673 `ReceiverObservation` carries only part of this proposed receipt and trusts the injected source to provide its guarantees. Its string identity and mock assertions do not authenticate a receiver or establish durable replay prevention. Implementing this contract requires a new adapter and validation; the proposed fields are not a claim about the present wire format.

## Canonical trust boundary

The canonical reader must independently identify the exact library, project and sequence (and event for materialization), produce a complete, versioned canonical observation after terminal quiescence, and verify the intended outcome or a pre-recorded restoration digest. It must independently verify source media integrity and unrelated-project integrity against appropriately captured, target-bound baselines. The reader must not infer these results from the sender, receipt, UI state, requested target, or a single uncorrelated snapshot. Changes between observation and release must be excluded or detected through a verified revision/snapshot protocol. Both routes, completed and restored outcomes, corrupted or missing baselines, target mismatches and concurrent changes need tests. What API can supply this observation and its isolation guarantees remains unverified.

## Coordination and migration

| Candidate | Finding |
| --- | --- |
| Single writer coordinator | Can serialize participants only if all writers and dispatchers are forced through it; legacy exclusion and crash-safe journal remain required. |
| OS-managed `flock` | Releases a cooperating process's lock on descriptor closure, but is advisory and cannot exclude an old writer. A stable lock inode and controlled descriptor inheritance are necessary. |
| Version-aware migration | Version markers let cooperating clients reject incompatible state; old clients can ignore them. |
| Managed upgrade and legacy exclusion | Potentially viable only with enforceable deployment/OS controls that prevent *all* old clients, descendants and pending dispatches from accessing the shared target, with audit and restart tests. Process names, elapsed time and PID checks are insufficient. |
| Fencing token | Useful only where every receiver and writer validates the token before effects; legacy clients do not. |
| Isolated new-generation state | Separating files avoids state-file collisions but does not stop a legacy writer or pending native dispatch from modifying the same Final Cut target. Isolation must cover the target and all access paths, not just a directory. |

Before any migration, inventory versioned binaries, extensions, helper processes, scheduled jobs, external clients, already queued receiver work and every path to the state and target. Establish an enforceable exclusion boundary, drain or prove quiescent all old executions, snapshot the old state without clearing it, atomically establish a new epoch under the enforced boundary, and verify the boundary persists across crashes, upgrades and restart. The precise enforcement mechanism and trust authority are unresolved; if any participant cannot be excluded or any prior dispatch cannot be proved terminal, remain closed. Do not delete or recreate a live lock file: different inodes can create separate lock domains. The [Apple `flock` manual](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/flock.2.html) explicitly describes locks as advisory.

## Reproducible experiment and promotion gates

Run `python3 -m unittest discover -s tests/research -p '*_test.py' -v` on a POSIX host. The independent subprocess experiment uses temporary files only. It checks cooperating contention, OS lock release after killing a holder, a legacy-style exclusive reservation creation while that lock is held, and the split-inode hazard after unlink. It does **not** prove exclusion of legacy writers, receiver quiescence, crash-durable transactions, filesystem-wide behavior, or Final Cut safety. It is not used by production.

Production enablement requires: an authenticated documented receiver with a tested durable no-replay receipt; an independently verified canonical reader and integrity baselines for both routes; enforceable inventory and exclusion/migration of all legacy participants and queued dispatches; separate-process race, crash and restart tests of the actual coordinator and migration; and separately approved disposable headed evidence on the exact candidate. Preserve existing reservations and remain unavailable whenever any condition is missing. #670 remains open until its own acceptance criteria are met.
