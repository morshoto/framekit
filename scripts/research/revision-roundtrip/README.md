# Revision round-trip research

Research fixtures only. They do not call Final Cut, establish a production MCP workflow, or authorize any native operation. The independently authored XML and synthetic media names are not Final Cut-produced evidence.

From this worktree after `pnpm install --frozen-lockfile`:

```sh
./node_modules/.bin/tsx --test scripts/research/revision-roundtrip/*.test.ts
node --test scripts/research/revision-roundtrip/*.test.mjs
```

The TypeScript characterization tests demonstrate current adapter/reconciliation boundaries, including the equal-name misdirection, negative audio lane, unsupported story element, and a blocked accepted-brief to version-B chain. Keep those results distinct from the proposed `matching.mjs` experiment.

In `independent.fcpxml`, the audio is nested under the primary asset clip. The imported occurrence and audio story element both lack an `attachedTo` relationship, even though the signed lane remains `-1`. Mapping that lane to a positive track alone cannot reconstruct the original parent relationship; a solution needs independently preserved and validated attachment information as well as a representation for signed lanes. This observation is limited to this fixture and import path.

The matcher compares a separately supplied source SHA-256 and normalized exact source interval, requiring uniqueness on each side and rejecting missing, invalid, or ambiguous intervals. A revision digest binds exact artifact bytes; callers must preserve a trusted expected digest and independently verify the source bytes and target. A separate XML-preserving prototype carries a specific external cut, title and negative audio lane into a synthetic B; it does not fix the IR compiler or establish arbitrary XML preservation. It cannot distinguish a replacement with the same source and range, identify trimmed or split clips, authenticate a source, prove continuity, preserve XML semantics, or prove that the generated B is editable in Final Cut. It is not integrated into production and is not evidence of a safe automatic rebase. Unknown or changed source intervals fail closed in this model.

The source XML in the existing independent fixtures uses FCPXML 1.11. They were originally checked with the installed DTD; syntactic/DTD validation is not evidence of correct import, editability, playback, identity, or native Undo. See issue #903 for pinned candidate, toolchain, hashes, negative controls and complete evidence limits.

Reproduce the bounded synthetic XML handoff (choose a fresh output path):

```sh
node scripts/research/revision-roundtrip/run-handoff.mjs /tmp/framekit-research-revision-b.fcpxml
python3 scripts/research/revision-roundtrip/verify-handoff.py /tmp/framekit-research-revision-b.fcpxml
xmllint --noout --dtdvalid 'file:///Applications/Final%20Cut%20Pro.app/Contents/Frameworks/Interchange.framework/Versions/A/Resources/FCPXMLv1_11.dtd' /tmp/framekit-research-revision-b.fcpxml
```

The source digests and project ID are placeholders; the script's name change is not user approval. Baseline and external XML are authored fixtures, not native exports. The proof is limited to selected XML fields and DTD conformance. It does not test actual media, signed source identity, arbitrary edits, source replacement, target authenticity, playback, editability, live recovery, or native Undo.

`revision-store.mjs` is an isolated create-only sidecar experiment. It syncs each newly created record and its parent directory and verifies exact artifact bytes and target against the recorded digest. `stored-handoff.mjs` reads prior A and external-edit records, creates a new B file and then its record. The tests spawn a separate Node process for readback, detect stale content, missing/partial records, wrong targets and symlinks, and show that a failure between output and record leaves an orphan rather than a completed transaction. No crash or power-loss durability has been proven; the two files are not atomic, directory or file replacement races are not fenced, and stored records are not authenticated. In particular, replacing both the record and artifact with another internally consistent pair passes; do not treat this prototype as trustworthy provenance or native identity. The test A/external pins and source digests are synthetic and the production project store is unchanged.

A second, narrowly scoped experiment preserves explicit `com.framekit.id` metadata on authored `asset-clip` elements across a source-in-point change and a same-name insertion. It requires a separately supplied expected source interval; rejects missing/duplicate/swapped anchors, changed source declarations, concurrent rename, equal rational source intervals and changes to the target's retained structure; and preserves the external XML while changing the selected name. This rejects many legitimate edits conservatively. Matching source URL and XML metadata are not authenticated: replacement with an indistinguishable clip remains possible, and Final Cut's retention of custom metadata is untested. The expected interval, hashes and project are synthetic inputs, not user approval or verified native identity.

Timing correction: the earlier `anchored-edit.fcpxml` changed its parent clip's `start` from 1s to 2s without adjusting the audio or title offsets. Since those offsets are in the parent time domain ([Apple timing attributes](https://developer.apple.com/documentation/professional-video-applications/timing-attributes)), the earlier external edit and B placed both anchors at -1s rather than 0s. The old DTD and attribute checks did not catch this; prior claims that they preserved placement were incorrect. The revised external fixture adjusts both offsets to 2s, and the independent Python verifier checks their 0s positions using exact rational arithmetic. The matcher compares direct audio and title offsets relative to the parent's `start` and rejects the previous shift. This is a fixture-specific check, not a general FCPXML timing engine: nested anchors, retiming and other element types remain unverified. It does not change the production adapter, whose imported audio timing is also not established by this experiment.

The matcher now rejects non-`asset-clip` spine elements in either revision, including a DTD-valid `clip` carrying a duplicate anchor. Before this check, such an element was ignored and the target was incorrectly accepted. It also rejects unsupported asset-clip child elements, including markers, retiming and nested anchors, even when their raw XML is identical on both sides: a parent in-point change can alter their effective placement. The accepted child shape is limited to the fixture's direct audio, title text/style and metadata. This deliberately excludes valid FCPXML structures and does not establish complete validation of the accepted shape.

```sh
research_dir=$(mktemp -d -t framekit-anchored)
node scripts/research/revision-roundtrip/run-anchored-handoff.mjs "$research_dir/b.fcpxml"
python3 scripts/research/revision-roundtrip/verify-anchored.py "$research_dir/b.fcpxml"
xmllint --noout --dtdvalid 'file:///Applications/Final%20Cut%20Pro.app/Contents/Frameworks/Interchange.framework/Versions/A/Resources/FCPXMLv1_11.dtd' "$research_dir/b.fcpxml"
```

The independent verifier checks the fixture's three source ranges, three metadata IDs, title text and negative audio lane. The authored A, independent edit and B pass the installed 1.11 DTD. This does not prove actual Final Cut import, playback, editability, metadata persistence, original-source identity, generalized preservation or native Undo. The existing IR compiler limitations remain.

A separate Ed25519 experiment signs a canonical fixture claim containing exact A and external-edit digests, target and occurrence IDs, a target-range manifest, rename and hashes of two synthetic byte buffers. Verification requires a separately trusted public key and rejects invalid key roles, a changed claim, stale input or source bytes, unexpected target, and noncanonical signed content. A test serializes the public key and envelope and verifies them in a new process using a separately supplied public-key fingerprint; substituting the key fails. The pure handoff intentionally accepts the same valid claim twice: replay protection and a durable transaction are not implemented.

```sh
research_dir=$(mktemp -d -t framekit-signed)
node scripts/research/revision-roundtrip/run-signed-fixture.mjs "$research_dir/b.fcpxml"
python3 scripts/research/revision-roundtrip/verify-anchored.py "$research_dir/b.fcpxml" 'Synthetic rename'
xmllint --noout --dtdvalid 'file:///Applications/Final%20Cut%20Pro.app/Contents/Frameworks/Interchange.framework/Versions/A/Resources/FCPXMLv1_11.dtd' "$research_dir/b.fcpxml"
```

The key is generated by the test process, not a user; no private key is saved. A signature authenticates only the signer and supplied claim under the assumption that the public-key pin is trusted. It does not prove human review, that synthetic bytes correspond to XML URLs or Final Cut's original source, that metadata survives real edits, or that B is imported/editable. It has no key provisioning, rotation, revocation, replay defense, durable signed approval store, native receiver fence or production integration.

A second signed-handoff experiment uses the existing create-only revision sidecar as a claim before writing B. Two test-owned processes using the same pinned test key and signed claim contend for one claim file; one materializes B and the other receives `EEXIST`. A later process also rejects the same claim. An output collision leaves the claim in place and preserves the existing file; it is not automatically retried. This is a bounded local result, not an atomic transaction: no crash/power-loss proof or verified completion/recovery protocol is supplied. The marker is unauthenticated and deletion permits replay, and a different trusted key creates a distinct claim even for the same result. It cannot exclude noncooperating writers, protect an actual approval store or fence any Final Cut receiver.
