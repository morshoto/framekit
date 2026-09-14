# Current-Version Non-UI Final Cut Timeline Snapshot Investigation

Status: decision recorded 2026-09-13

## Decision

Decision: No supported non-UI complete timeline snapshot is available from the
inspected Final Cut Pro version.

The inspected Final Cut Pro 10.7.1 installation does not provide a supported
non-UI path that returns a complete, target-bound canonical timeline snapshot.
Framekit must keep the bundled Workflow Extension at `metadata-only` and must
not promote its live state to `canonicalDocument.read`.

The supported complete interchange path remains FCPXML. It is an artifact
source when a user supplies `FRAMEKIT_FCPXML_PATH`, and the headed native
provider obtains a live canonical snapshot through `File > Export XML`. Neither
path is a current-version direct, non-UI live snapshot API.

## Investigation boundary and evidence

This was a read-only inspection. It did not focus, mutate, or export a Final
Cut project. The machine and application evidence was:

| Surface | Evidence | Result |
| --- | --- | --- |
| Installed application | `/Applications/Final Cut Pro.app/Contents/Info.plist`: bundle ID `com.apple.FinalCut`, short version `10.7.1`, bundle version `410082` | Target version is explicit |
| Read-only Apple Events | `sdef "/Applications/Final Cut Pro.app"` declares access group `com.apple.FinalCut.library.inspection` with `access="r"` | Supported read-only library inspection exists |
| Apple Event commands | The current dictionary declares only the `get` command | No current-version direct XML export command is declared |
| Apple Event object model | The dictionary declares `library`, `event`, `project`, `sequence`, and `item`; sequence fields are name, ID, container, start time, duration, frame duration, timecode format, and essential properties | Useful metadata, not complete timeline occurrences |
| Installed ProExtensionHost framework | `/Applications/Final Cut Pro.app/Contents/Frameworks/ProExtensionHost.framework/ProExtensionHost` is a universal binary; `strings` identifies `ProExtension-41000.8.16`; Objective-C metadata lists `FCPXLibrary.events`, `FCPXEvent.clips/projects`, `FCPXProject.sequence`, and sequence/timeline timing APIs | The current host has library/event collections and metadata, but no complete project-timeline occurrence, role, resource-binding, or storyline relationship contract |
| ProExtensionHost bridge surface | `ProExtensionHostShim/ProExtensionHost.h` and the bridge expose project UID/sequence, sequence timing, active sequence, selected sequence range, playhead time, and three observer callbacks | Framekit uses only the supported metadata subset and does not invent a canonical snapshot |
| Current bridge behavior | `FinalCutLiveWorkflowExtension.swift` reports `canonicalTimelineMode: metadata-only`, `timelineSnapshotRead: false`, and rejects `snapshot`, `apply`, and `restore` with `CAPABILITY_UNAVAILABLE` | Existing routing already fails closed |

The evidence can be reproduced without launching or focusing Final Cut Pro:

```sh
FRAMEKIT_FINAL_CUT_APP="/Applications/Final Cut Pro.app"
FRAMEKIT_FINAL_CUT_PLIST="$FRAMEKIT_FINAL_CUT_APP/Contents/Info.plist"
FRAMEKIT_FINAL_CUT_HOST="$FRAMEKIT_FINAL_CUT_APP/Contents/Frameworks/ProExtensionHost.framework/ProExtensionHost"

/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$FRAMEKIT_FINAL_CUT_PLIST"
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$FRAMEKIT_FINAL_CUT_PLIST"
/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$FRAMEKIT_FINAL_CUT_PLIST"
sdef "$FRAMEKIT_FINAL_CUT_APP" | rg 'access-group|<command|<class '
strings "$FRAMEKIT_FINAL_CUT_HOST" | rg 'ProExtension-|FCPX(Library|Event|Project|Sequence|Timeline)'
otool -ov "$FRAMEKIT_FINAL_CUT_HOST" | rg 'FCPX(Library|Event|Project|Sequence|Timeline)|sendGetElementsEvent'
```

The Apple Event inventory was taken from the installed app, not from a legacy
Final Cut Pro 7 dictionary. The older Apple Events/XML material is not evidence
that Final Cut Pro 10.7.1 implements a direct current-version XML command.

## Read-only SQLite investigation

The `.fcpbundle` stores are SQLite databases, but they are not a supported
timeline interchange contract. A read-only inspection was run against a Final
Cut Pro 10.7.1 backup without opening or focusing Final Cut Pro:

```sh
SQLITE_DB="/path/to/CurrentVersion.fcpevent"
sqlite3 -readonly -batch -noheader "$SQLITE_DB" \
  'PRAGMA query_only=ON; SELECT name, sql FROM sqlite_master WHERE type = "table" ORDER BY name;'
sqlite3 -readonly -header "$SQLITE_DB" \
  'PRAGMA query_only=ON; SELECT ZTYPE, COUNT(*) FROM ZCOLLECTION GROUP BY ZTYPE ORDER BY ZTYPE;'
sqlite3 -readonly -header "$SQLITE_DB" \
  'PRAGMA query_only=ON; SELECT Z_PK, Z_OPT, ZIDENTIFIER, ZTYPE FROM ZCOLLECTION WHERE ZTYPE LIKE "FFMediaEventProject%" OR ZTYPE IN ("FFAnchoredSequence", "FFAnchoredClip", "FFAsset", "FFMediaRep") ORDER BY Z_PK;'
```

The captured `CurrentVersion.fcpevent` contained the following schema surfaces:

| Surface | Observed evidence | Trust boundary |
| --- | --- | --- |
| Relational catalog | `ZCATALOGROOT`, `ZCOLLECTION`, `Z_3CHILDCOLLECTIONS`, `Z_PRIMARYKEY`, and Core Data metadata tables | Object type names, local primary keys, `Z_OPT`, and some identifiers are observable |
| Project/sequence objects | `FFMediaEventProject` (1), `FFMediaEventProjectData` (1), `FFAnchoredSequence` (304), `FFAnchoredClip` (4) | Rows are not a target-bound ordered timeline occurrence list |
| Media objects | `FFAsset` (301), `FFAssetRef` (301), `FFMediaRep` (301) | Resource-like identities are visible, but timeline bindings are not relationally complete |
| Archived payload | `ZCOLLECTIONMD.ZDICTIONARYDATA` (2,727 rows); the captured payload begins with `bplist00` and decodes as `NSKeyedArchiver` | Contents are undocumented and version-bound; no fields are promoted to canonical state |
| Revision signals | SQLite file digest, schema version 18, and observed `Z_OPT` values | These detect storage changes, but do not establish a Final Cut editor revision |

Framekit now exposes `FinalCutSqliteInspectionProvider` as a read-only
observation contract. It runs `sqlite3 -readonly`, enables `query_only`,
captures schema/type/count evidence, hashes the database bytes, and compares
two observations for storage drift. It never returns a `ProjectSnapshot`,
reads BLOB contents into the model, or performs a write. The deterministic
fixture is `tests/fixtures/final-cut-sqlite-inspection.json`.

The observed coverage for the captured database is:

| Snapshot field | SQLite result |
| --- | --- |
| Project identity | `partial`: a project object type and local identifier surface exist |
| Sequence identity | `unknown` |
| Clip occurrences | `unknown` |
| Media identity | `partial`: asset/media-representation objects exist, but complete bindings are opaque |
| Rational timing | `unknown` |
| Roles | `unknown` |
| Storyline relationships | `unknown` |
| Markers/captions | `unknown` |
| Revision | `partial`: digest and object-version evidence only |

Therefore the answer to the issue's read-side question is bounded: SQLite can
provide a useful background storage-change signal and partial project/media
inventory, but it cannot currently provide the complete canonical timeline
snapshot required by Framekit. A backgrounded filesystem read was reproduced
against a backup. Locked-console behavior for a live bundle remains an
experiment-level question and is not claimed by this provider; filesystem
readability does not prove that Final Cut has flushed or committed the latest
state. The SQLite observation is not a production source for canonical
timeline state.

The installed host also has generic `sendAppleEvent:`,
`sendGetObjectPropertyEvent:code:`, and `sendGetElementsEvent:code:` methods.
Those transport operations do not add timeline semantics that the current
`FCPXSequence` object does not expose. `FCPXEvent.clips` is an event-level
collection; it is not a target-bound list of timeline occurrences with roles,
lanes, source coordinates, and storyline relationships.

## Supported artifact path

Apple's current FCPXML documentation describes XML as the interchange format
for libraries, events, projects, clips, resources, and timeline sequences. The
current Final Cut Pro user guide documents exporting XML through `File > Export
XML`, including selection of the XML version and metadata view. The export
operation is a supported interchange path, but it requires the project or
timeline to be selected in Final Cut Pro. Framekit therefore keeps the source
boundary explicit:

| Source | Mode | Canonical live snapshot? |
| --- | --- | --- |
| User-provided `FRAMEKIT_FCPXML_PATH` | `fcpxml-artifact` | No; it is an explicit file artifact |
| Headed `File > Export XML` provider | `canonical-live` | Yes, after target validation and complete FCPXML parsing |
| Workflow Extension Apple Events | `metadata-only` | No; the current dictionary has no complete snapshot contract |
| `.fcpbundle` internals | Read-only observation only | Storage digest and partial inventory may inform diagnostics/drift signals; undocumented fields never become canonical |

References:

- [Apple FCPXML Reference](https://developer.apple.com/documentation/professional-video-applications/fcpxml-reference)
- [Apple FCPXML Document Type Definition](https://developer.apple.com/documentation/professional-video-applications/document-type-definition)
- [Apple Support: Use XML to transfer projects in Final Cut Pro](https://support.apple.com/guide/final-cut-pro/verdbd66ae/mac)

## Minimum complete snapshot contract

Framekit's `ProjectSnapshot` is complete only when all of the following are
available for one explicit project/sequence target:

| Required field | Required meaning |
| --- | --- |
| Project/sequence identity | `projectId`, `projectName`, timeline `id`, and timeline `name` identify the selected target; identity must be target-bound and unambiguous |
| Media/resource identity | Every referenced resource has a stable `mediaId` and a resolvable source or equivalent resource identity |
| Clip occurrences | Every timeline occurrence has its own occurrence ID, media binding when applicable, name, and complete occurrence data; an empty list cannot stand in for an unknown list |
| Rational coordinates | Timeline duration/frame duration and occurrence start/duration use exact rational values; convenience seconds are not sufficient by themselves |
| Roles | Video, audio, music, title, or provider-specific role information is retained rather than inferred from track position |
| Storyline relationships | Spine order, lanes, attached-to links, and before/after or equivalent relationship data are retained for heterogeneous story elements |
| Markers and captions | Representable marker and caption data is retained when present |
| Revision | The snapshot has a source-bound revision that can be compared before and after an operation |

A provider may claim `canonicalDocument.read` only when the target is explicit,
all required collections are complete, identities are unique, media references
resolve, rational coordinates are valid, and the returned revision belongs to
that same target. Project identity, sequence identity, clip occurrences,
media/resource identity, rational coordinates, roles, and storyline
relationships are jointly required; metadata for only some of them remains
metadata-only.

## Failure modes and routing

- A provider that cannot produce the complete contract reports
  `canonicalTimelineMode: metadata-only` and `timelineSnapshotRead: false`.
- `project.inspect`, canonical diff, preview, execute, and undo fail with
  `CAPABILITY_UNAVAILABLE` before invoking an unavailable snapshot provider.
- Missing or mutable target identity, partial collections, unresolved media,
  invalid rational coordinates, ambiguous occurrences, or stale revisions fail
  closed. They must not be replaced with guessed values or an empty timeline.
- An FCPXML artifact is reported as `fcpxml-artifact`; it is never silently
  promoted to a live Final Cut target or to headed-native evidence.
- Final Cut's internal `.fcpbundle` SQLite stores are limited to read-only
  observation. They are not a supported canonical source: these undocumented
  implementation details cannot establish a stable, complete current-version
  snapshot contract.

## Follow-up decision

Do not add a non-UI canonical live snapshot adapter for Final Cut Pro 10.7.1.
The SQLite provider is deliberately limited to read-only observation and drift
signals. Re-open canonical promotion only when a future Final Cut version
exposes a documented or empirically stable interface that returns the complete
contract above, is target-bound, and has evidence for background behavior.
Until then, retain the split between background metadata/observation, explicit
FCPXML artifacts, and headed canonical export.
