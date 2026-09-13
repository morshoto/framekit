# Non-UI Final Cut Native Write and Undo Investigation

Issue: [#256](https://github.com/morshoto/framekit/issues/256)  
Status: Decision recorded (read-only)  
Last verified: 2026-09-13  
Target: Final Cut Pro 10.7.1 (build 410082)  
Evidence tier: Apple documentation plus installed Final Cut surface inspection

## Conclusion

No supported non-UI native timeline write or native Undo API is available for
the target Final Cut version. The supported non-UI surfaces are limited to
read-only library metadata and file-based FCPXML interchange. The bundled
Workflow Extension remains metadata-only, and native timeline writes remain a
separate headed Accessibility capability.

This is a read-only investigation. It did not activate Final Cut, select a
project or clip, change focus, send an import event, mutate a timeline, or
invoke Undo.

## Decision matrix

The final column uses these dispositions:

- **background-capable**: safe without a frontmost Final Cut session for the
  stated scope;
- **headed-only**: Final Cut may need to process the request in a user-facing
  session, and the surface does not satisfy the native executor contract;
- **unavailable**: no supported API evidence satisfies the operation.

| Operation | ProExtensionHost | Current Final Cut Apple Events | Workflow Extension host APIs | Documented FCPXML interchange | Native executor disposition |
| --- | --- | --- | --- | --- | --- |
| `media import and append` | No clip or library mutation method; the public proxy exposes active-sequence metadata and playhead movement only. | The documented `Open` `Document` event can submit an FCPXML file, but the current app dictionary grants read-only library inspection and does not provide target-bound append, readback, or rollback. | No import, append, or clip-placement method. | File generation is background-capable; importing the file is an interchange workflow and does not prove append to the active timeline. | **headed-only** for a Final Cut import attempt; no background-capable native append. |
| `trim and timeline placement` | No clip occurrence, trim, or placement method. | No documented active-timeline trim or placement command. | No clip mutation method. | Clip order and rational timing can be represented in an artifact, but editing that artifact does not mutate the open timeline. | **unavailable** as a native non-UI operation. |
| `title placement` | No title or timeline insertion method. | No documented target-bound title placement command. | No title insertion method. | FCPXML can describe documented timeline items and references where a lossless schema mapping exists; that remains artifact/import behavior. | **unavailable** as a native non-UI operation. |
| `picture-in-picture and transform properties` | No transform or effect mutation method. | No documented target-bound transform command. | No transform or effect mutation method. | FCPXML can carry documented editing decisions and effect references, but there is no live target readback or native Undo proof. | **unavailable** as a native non-UI operation. |
| `mask properties` | No mask mutation method. | No documented target-bound mask command. | No mask mutation method. | No safe, current-version mapping was established for a live mask write; approximate XML is out of scope. | **unavailable** as a native non-UI operation. |
| `native Undo and transaction restoration` | No Undo, transaction, or restore method. | No documented native Undo or transaction-restore command in the current app-specific dictionary. | No Undo or restore method. | Artifact rollback can restore a managed file; it cannot restore an already imported or active native timeline. | **unavailable** as a native non-UI operation. |

### Supported background candidates

These candidates are useful for background workflows but do not promote any
native write capability:

| Candidate | Disposition | Exact boundary |
| --- | --- | --- |
| Final Cut library Apple Events | **background-capable** for read-only metadata | The installed `ProEditor.sdef` exposes library, event, project, and sequence inspection through `com.apple.FinalCut.library.inspection` with `access="r"`. It does not expose a complete timeline snapshot or a write transaction. |
| Managed FCPXML artifact | **background-capable** for file interchange | Framekit can read, edit, verify, diff, and roll back the managed artifact. The result is artifact evidence and does not claim to change the open Final Cut project. |
| FCPXML `Open` `Document` Apple Event | **headed-only** as a native workflow | Apple documents sending an FCPXML file to Final Cut, but the example activates the application and import can involve library or project interaction. It has no target-bound native read-after-write or Undo contract. |
| ProExtensionHost / Workflow Extension | **unavailable** for writes | The documented host proxy is hosted by Final Cut and exposes active-sequence metadata, time range, playhead, and change observation, not clip-level mutation. |

## Evidence and observations

### Installed Final Cut surface

The target app reports version `10.7.1` and build `410082`. The app-specific
dictionary is at `Contents/Resources/ProEditor.sdef`. Its relevant surface is:

- the `com.apple.FinalCut.library.inspection` access group with `access="r"`;
- read-only application library elements and library/event/project/sequence
  properties;
- a `get` command for retrieving object data; and
- no app-specific command for an active timeline write, transaction, or Undo.

The installed `ProExtensionHost.framework` contains the public host model and
also has binary selectors such as `clips`, `projects`, and `sendAppleEvent`.
Binary presence is not API support: those selectors are not part of the
checked-in public shim or the current Apple documentation, so Framekit must
not call them or infer semantics from them.

The reproducible, read-only inspection commands are:

```sh
FINAL_CUT_APP="${FINAL_CUT_APP:-/Applications/Final Cut Pro.app}"

/usr/libexec/PlistBuddy \
  -c 'Print :CFBundleShortVersionString' \
  "$FINAL_CUT_APP/Contents/Info.plist"

sdef "$FINAL_CUT_APP" | rg '<access-group|<command|<class |<property |<element '

nm -gU \
  "$FINAL_CUT_APP/Contents/Frameworks/ProExtensionHost.framework/ProExtensionHost" \
  | rg 'FCPXHostSingleton|FCPXTimeline|FCPXProject|FCPXSequence|FCPXEvent|FCPXLibrary'
```

The `sdef` and `nm` commands inspect installed metadata only. They do not send
Apple Events or launch Final Cut.

### Documented API evidence

- [Interacting with the Final Cut Pro Timeline](https://developer.apple.com/documentation/professional-video-applications/interacting-with-the-final-cut-pro-timeline)
  documents access to the host proxy, active sequence, sequence range,
  playhead, and timeline observers. Its documented mutation is moving the
  playhead, not editing clips.
- [`FCPXTimeline`](https://developer.apple.com/documentation/professional-video-applications/fcpxtimeline),
  [`FCPXProject`](https://developer.apple.com/documentation/professional-video-applications/fcpxproject),
  and [`FCPXSequence`](https://developer.apple.com/documentation/professional-video-applications/fcpxsequence)
  document metadata and timing properties, not clip-level writes or Undo.
- [Sending Data Programmatically to Final Cut Pro](https://developer.apple.com/documentation/professional-video-applications/sending-data-programmatically-to-final-cut-pro)
  documents sending a saved FCPXML file through the `Open` `Document` Apple
  Event. This is file import/interchange, not a target-bound active-timeline
  mutation API.
- The [FCPXML Reference](https://developer.apple.com/documentation/professional-video-applications/fcpxml-reference)
  documents resources, events, projects, sequences, and editing decisions,
  while explicitly treating FCPXML as interchange rather than a substitute for
  native library data.

The older [Apple Events and Final Cut Pro](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/FinalCutPro_XML/AppleEvents/AppleEvents.html)
page describes legacy XML import/export events, but it is marked retired and
does not establish a current-version transaction, target identity, readback,
or Undo guarantee.

## Minimum safe native executor contract

No candidate is background-capable for a native write until it satisfies every
item below:

1. **Target identity** — bind an immutable project ID, sequence ID, and exact
   occurrence/media target. Names or the visible window are not identities.
2. **Base revision** — read and retain the target revision before preview and
   reject stale or changed context before mutation.
3. **Preview diff** — produce the requested change against that target without
   changing Final Cut.
4. **Atomic mutation** — apply the complete operation or report failure without
   claiming a partial edit is successful.
5. **Post-write readback** — read the same target after mutation and compare
   requested properties, coordinates, identity, and an advancing revision.
6. **Failure handling** — use bounded deadlines and structured errors for
   unavailable, stale, mismatched, cancelled, timed-out, and partially applied
   states. Never convert an absent readback into success.
7. **Reversible restoration** — provide native Undo or a provider-owned restore
   operation, then read back the original target and verify restoration.

The contract preserves Framekit's existing `CAPABILITY_UNAVAILABLE` boundary.
`connection.status: ready`, metadata observations, FCPXML artifact success,
and installed-but-undocumented selectors are not native write evidence.

## Safety decision and follow-up

Framekit should keep the current split:

- use library Apple Events and the Workflow Extension only for their supported
  observed metadata surfaces;
- use managed FCPXML for explicit background artifact workflows;
- retain headed, frontmost, focus, preview, readback, revision, and native Undo
  guards for Accessibility-driven writes; and
- keep unsupported native operations unavailable rather than approximating
  them.

No undocumented `.fcpbundle` SQLite read or write dependency must not be introduced.
The internal bundle is not a supported interchange or transaction contract and
cannot satisfy target identity, atomic mutation, readback, or restoration.

If Apple exposes a future write-capable provider, it must first add a bounded
proof against a disposable project. That proof must record the Final Cut
version, target identity, base/after/restored revisions, preview diff,
post-write readback, failure behavior, and verified restoration before the
capability matrix can change.
