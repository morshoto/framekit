# `.fcpevent` shadow materialization research

Status: investigated 2026-09-16. This is an experiment record, not a Final
Cut Pro storage contract or a supported publishing implementation.

## Decision

**Safe direct materialization of a versioned FCPXML project into
`CurrentVersion.fcpevent` is not currently possible.**

The inspected store provides useful SQLite-only inventory and a small,
shadow-only control mutation can pass `PRAGMA integrity_check`. It does not
provide the undocumented Core Data model, archive encoder, relationship
semantics, revision protocol, or Final Cut reopen/readback needed to create or
update a project safely. In particular, a changed digest, a committed SQL
transaction, or an SQLite integrity result is not evidence that Final Cut will
open the library or materialize the requested Timeline IR.

| Claim | Evidence level | Result |
| --- | --- | --- |
| Schema/type inventory and keyed-archive decoding | SQLite-only | Observed against a read-only Final Cut 10.7.1 store |
| Controlled project-row rename in a disposable shadow | SQLite-only | One row and the database digest changed; all keyed-archive digests were unchanged; integrity check returned `ok` |
| FCPXML can represent a versioned project | FCPXML-only | Supported interchange, but not proof of internal store construction |
| Shadow direct mutation produces an openable target-bound project | Final Cut reopen | **Not established**; the approved UI-control channel failed before Final Cut could be focused |

The source bundle was never opened for write. The source event database's
SHA-256 was checked before and after the control and remained unchanged.

## Observed Core Data schema

The following is an observation from one small disposable-project event store.
It is version- and library-dependent; code must compare the exact SQL text and
fail closed on any mismatch.

| Table | Observed role | Mutation implication |
| --- | --- | --- |
| `ZCATALOGROOT` / `ZCATALOGROOTMD` | Catalog root plus archived catalog metadata | Root/archive invariants are unknown |
| `ZCOLLECTION` | Main Core Data entity rows: `Z_PK`, `Z_ENT`, `Z_OPT`, catalog/metadata references, identifier, name, and `ZTYPE` | Local primary keys and optimistic versions are observable only |
| `ZCOLLECTIONMD` | Entity metadata rows; `ZDICTIONARYDATA` is an `NSKeyedArchiver` binary plist | Required encoder/class graph is undocumented |
| `Z_3CHILDCOLLECTIONS` | Directed parent/child collection join table | Its rows do not by themselves explain semantic ownership/order |
| `Z_METADATA` | Core Data store metadata (`Z_UUID`, plist) | Store identity must be preserved, not synthesized casually |
| `Z_MODELCACHE` | Opaque Core Data model cache | Model compatibility is unverified |
| `Z_PRIMARYKEY` | Per-entity maxima (`Z_ENT`, `Z_NAME`, `Z_MAX`) | Bumping a maximum alone cannot make a valid object graph |

The store contained these `ZCOLLECTION.ZTYPE` families. The role labels are
only grounded where the row/archive/relationship evidence agrees.

| `ZTYPE` family | Observed role | Evidence / limitation |
| --- | --- | --- |
| `FFMediaEventProject` | Project collection | One project row, its own UUID and metadata archive |
| `FFMediaEventProjectData` | Project-associated data object | Its UUID appears as `projectDataID` in the project archive |
| `FFAnchoredSequence` | Sequence object | Sequence archive exposes `displayName`, timing, and media identifier |
| `FFSequenceInfo`, `FFAnchoredCollection`, `FFAnchoredMediaComponent`, `FFAnchoredGapGeneratorComponent` | Sequence/anchored-item graph components | Join edges expose links, but not a complete ordered timeline contract |
| `FFAssetRef` | Media/resource reference | Asset reference archive exposes a media identifier/name pair |
| `FFEffectStack`, `FFHeConformEffect`, `FFIntrinsicColorConformEffect`, `FFHeColorEffect` | Effect-stack and intrinsic-effect objects | Array/join edges show containment candidates; parameters remain archive-defined |
| `NSSet`, `NSArray` | Persisted collection wrappers | Wrapper `ZNAME` values such as `sequence`, `assetReferences`, and `containedItems` are useful hints, not schema documentation |

### Observed object graph

The following is the concrete relationship pattern observed in the sample; an
arrow is a `Z_3CHILDCOLLECTIONS` row, not a claim that all arrows are semantic
ownership or timeline order.

```text
FFMediaEventProject (UUID P)
  -> NSSet(sequenceInfo) -> FFSequenceInfo
  -> NSSet(rootFolder)   -> FFMediaEventFolder
  -> NSSet(assetReferences) -> FFAssetRef

FFMediaEventProjectData (UUID PD, referenced by project archive key projectDataID)
  -> NSSet(sequence) / NSSet(ownedMedia) -> FFAnchoredSequence (UUID S)

FFAnchoredSequence
  -> NSSet(primaryObject) -> FFAnchoredCollection
  -> NSSet(sequenceInfo) / NSSet(userDefaults)

FFAnchoredCollection -> NSArray(containedItems)
  -> FFAnchoredGapGeneratorComponent | FFAnchoredMediaComponent
FFAnchoredMediaComponent -> NSSet(media) -> FFAssetRef
FFEffectStack -> NSSet/NSArray(intrinsicEffects) -> conform/color effects
```

The absence of a declared foreign-key constraint, and the fact that project to
project-data binding is carried in an archive key rather than a relational
column, are material reasons not to fabricate this graph.

## Archive identification and decoding

Every sampled `ZCOLLECTIONMD.ZDICTIONARYDATA` began with `bplist00` and
decoded with `plutil` as an `NSKeyedArchiver` archive. The reproducible,
read-only extraction command is:

```sh
sqlite3 -readonly -noheader "$DB" \
  "PRAGMA query_only=ON; SELECT hex(ZDICTIONARYDATA) FROM ZCOLLECTIONMD WHERE Z_PK=$MD_PK;" \
  | xxd -r -p | plutil -p -
```

For the observed project, first locate candidates relationally, then validate
their archive contents:

```sql
PRAGMA query_only=ON;
SELECT c.Z_PK, c.Z_OPT, c.ZIDENTIFIER AS collection_uuid, c.ZMETADATA AS md_pk
FROM ZCOLLECTION AS c
WHERE c.ZTYPE = 'FFMediaEventProject';

SELECT c.Z_PK, c.Z_OPT, c.ZIDENTIFIER AS collection_uuid, c.ZMETADATA AS md_pk
FROM ZCOLLECTION AS c
WHERE c.ZTYPE = 'FFAnchoredSequence';
```

The sampled project row mapped to archive keys including `projectDataID` and
the event display name. The sampled sequence row mapped to `displayName`,
`mediaIdentifier`, `clippedRange`, `unclippedStart`, `anchoredLane`, and
`videoProps`; it also contained `FigTimeObj` / `FigTimeRangeObj` records.
These are useful *observations*, but their object UID references, class names,
default values, and omitted keys must all round-trip through an Apple encoder
before they can be used for a writer.

Identity has three non-interchangeable scopes:

1. `Z_PK` is an integer local to this SQLite store and entity allocation.
2. `ZIDENTIFIER` is a UUID-like collection identifier and is the best
   within-store anchor observed for a project/sequence object.
3. `Z_METADATA.Z_UUID` identifies the Core Data store; archive values such as
   `projectDataID` and `mediaIdentifier` add further opaque identity layers.

`Z_OPT` is Core Data's optimistic version signal. A writer would have to check
the expected version for every changed `ZCOLLECTION` *and* `ZCOLLECTIONMD`
row, update every participating row consistently, and abort on a mismatch.
The sample does not establish which related rows Final Cut increments for a
project edit, so `Z_OPT + 1` is not a valid project recipe.

## Before/after control diff

This deliberately does **not** claim to be a Final Cut UI edit. It is a
reproducible shadow-only sensitivity control: the sample project's
`FFMediaEventProject` row was renamed by an allowlisted transaction in a copy
of the bundle. It demonstrates the narrow fact that SQLite accepts that row
change and its own integrity checker passes.

| Evidence | Before | After |
| --- | --- | --- |
| Event DB SHA-256 | `5b41970aec6e06f94562844d888bf9bb2966eac6f728d3ade2f899d1d8a5a07b` | `4871ffd313a4d516335263e9ef9bd5b2f9683131e371664654c5f8bbf77c755f` |
| `ZCOLLECTION` PK 10 | `Z_OPT=2`, empty `ZNAME`, `ZTYPE=FFMediaEventProject`, `ZMETADATA=8` | `Z_OPT=3`, `ZNAME=Framekit Native E2E — shadow control`, same type/metadata |
| All `ZCOLLECTIONMD` rows | SHA3-256 digest inventory | No BLOB digest changed |
| SQLite integrity | n/a | `PRAGMA integrity_check` = `ok` |
| Original event DB SHA-256 after control | `5b419…a07b` | unchanged |

The exact control procedure is:

```sh
# DB must resolve below a newly copied disposable .fcpbundle only.
cp "$DB" "$SHADOW_ROOT/before-CurrentVersion.fcpevent"
sqlite3 "$DB" "
  BEGIN IMMEDIATE;
  UPDATE ZCOLLECTION
  SET ZNAME = :new_name, Z_OPT = Z_OPT + 1
  WHERE Z_PK = :project_pk AND ZTYPE = 'FFMediaEventProject' AND Z_OPT = :expected_opt;
  SELECT changes();
  COMMIT;"
sqlite3 "$DB" 'PRAGMA integrity_check;'
```

For a **real Final Cut single-edit experiment** (clip rename, marker, or
trim), capture `before` and `after` only around one UI action on the same
disposable project, then diff rows and BLOB digests:

```sh
sqlite3 -readonly -header "$BEFORE" 'PRAGMA query_only=ON;
  SELECT Z_PK,Z_ENT,Z_OPT,ZCATALOG,ZMETADATA,ZIDENTIFIER,ZNAME,ZTYPE FROM ZCOLLECTION ORDER BY Z_PK;'
sqlite3 -readonly -header "$AFTER"  'PRAGMA query_only=ON;
  SELECT Z_PK,Z_ENT,Z_OPT,ZCATALOG,ZMETADATA,ZIDENTIFIER,ZNAME,ZTYPE FROM ZCOLLECTION ORDER BY Z_PK;'

for DB in "$BEFORE" "$AFTER"; do
  sqlite3 -readonly -header "$DB" 'PRAGMA query_only=ON;
    SELECT Z_PK,Z_OPT,ZCOLLECTION,length(ZDICTIONARYDATA) AS bytes,
           hex(sha3(ZDICTIONARYDATA,256)) AS blob_sha3_256
    FROM ZCOLLECTIONMD ORDER BY Z_PK;'
done
```

The required UI experiment was not run in this investigation: the approved
Computer Use bridge returned `Sky Computer Use native pipe startup failed`
before it could inspect/focus Final Cut. Consequently there is no honest
Final-Cut-authored clip/marker/trim delta, no archive-field attribution for
one, and no reopen result.

## Minimal versioned-project recipe: intentionally blocked

There is no safe SQL recipe to publish today. The only responsible minimum is
the following fail-closed pseudocode, which makes its missing empirical gates
explicit rather than inventing SQL for an undocumented model:

```text
require source bundle is never writable
shadow = byte_for_byte_copy(source bundle) below dedicated shadow root
require exact schema fingerprint == a versioned, reopen-proven recipe
backup every affected store and record source/shadow digests
require fresh target-bound project + sequence identities do not exist
require archive encoder can generate every object UID/class/default/key seen in
        a Final-Cut-authored create-project before/after experiment
require relational graph, Z_PRIMARYKEY allocation, catalog links, Z_OPT changes,
        and revision/archive changes match that authored experiment

BEGIN IMMEDIATE
  allocate collision-free project/sequence identities using proven Final Cut rules
  insert the complete project/project-data/sequence/component/effect/resource graph
  insert every matching metadata archive and relationship edge
  update every proven primary-key and revision record
  assert each optimistic version is the expected value
COMMIT

require PRAGMA integrity_check == ok
require Final Cut reopens the shadow bundle
require target-bound FCPXML export/readback matches desired Timeline IR
otherwise restore backup, retain evidence, and report failure (never native success)
```

The first six `require` conditions have not been proven. In particular,
collision safety cannot be reduced to generating UUIDs: it also includes Core
Data entity allocation, archive object UID topology, catalog/store identity,
and all references that Final Cut creates. Existing projects must never be
selected by name for overwrite; a candidate must match the full target tuple
or the operation must fail.

## Readback recipe and its limits

SQLite can re-find a **storage object**, not a complete timeline target. The
least-weak lookup uses an exact tuple captured before mutation:

```sql
PRAGMA query_only=ON;
SELECT c.Z_PK, c.Z_OPT, c.ZIDENTIFIER, c.ZMETADATA
FROM ZCOLLECTION AS c
WHERE c.ZTYPE = 'FFMediaEventProject' AND c.ZIDENTIFIER = :project_uuid;

SELECT c.Z_PK, c.Z_OPT, c.ZIDENTIFIER, c.ZMETADATA
FROM ZCOLLECTION AS c
WHERE c.ZTYPE = 'FFAnchoredSequence' AND c.ZIDENTIFIER = :sequence_uuid;
```

Decode both metadata archives and require the recorded project-data UUID,
sequence display name, media identifier, and relationship reachability to
match. A missing/duplicate result, archive decode failure, unexpected `Z_OPT`,
or opaque relationship fails closed. This can observe object identities, names,
some timing values, media references, row counts, and archive digests. It
cannot establish complete occurrence ordering, roles, transitions/effects,
markers, rational placement, or a target-bound editor revision, so it cannot
compare a full desired Timeline IR.

Final Cut reopen/readback is a distinct and mandatory proof level: reopen the
shadow library, select the exact project/sequence by the captured identity,
export/obtain target-bound FCPXML, parse it, and compare the complete desired
Timeline IR (resources, occurrences, rational ranges, roles, storyline links,
effects, markers, and revision). Only that successful readback can be called
native completion.

## Unresolved invariants and next experiment

- The Core Data model/cache versioning and entity allocation protocol.
- Full `NSKeyedArchiver` classes, keys, object UID graph, and default-value
  rules for create-project, sequence, marker, trim, and effect changes.
- Which `ZCOLLECTION`, `ZCOLLECTIONMD`, catalog, primary-key, and store rows
  Final Cut changes atomically for each edit.
- Relationship direction/order semantics and the mapping from asset refs to
  timeline occurrences.
- Whether Final Cut rewrites, repairs, rejects, or silently ignores a
  SQL-mutated shadow after reopen.

The next safe experiment is a single Final-Cut-authored action on a disposable
shadow with an immediately captured before/after DB pair and target-bound
reopen export. Until that exists for a fixed Final Cut version, keep direct
SQLite writes restricted to the existing reversible shadow control and do not
wire FCPXML-to-SQLite materialization into Framekit.
