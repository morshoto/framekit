# Revision round-trip research

Research fixtures only. They do not call Final Cut, establish a production MCP workflow, or authorize any native operation. The independently authored XML and synthetic media names are not Final Cut-produced evidence.

From this worktree after `pnpm install --frozen-lockfile`:

```sh
./node_modules/.bin/tsx --test scripts/research/revision-roundtrip/*.test.ts
node --test scripts/research/revision-roundtrip/*.test.mjs
```

The TypeScript characterization tests demonstrate current adapter/reconciliation boundaries, including the equal-name misdirection, negative audio lane, unsupported story element, and a blocked accepted-brief to version-B chain. Keep those results distinct from the proposed `matching.mjs` experiment.

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

```sh
research_dir=$(mktemp -d -t framekit-anchored)
node scripts/research/revision-roundtrip/run-anchored-handoff.mjs "$research_dir/b.fcpxml"
python3 scripts/research/revision-roundtrip/verify-anchored.py "$research_dir/b.fcpxml"
xmllint --noout --dtdvalid 'file:///Applications/Final%20Cut%20Pro.app/Contents/Frameworks/Interchange.framework/Versions/A/Resources/FCPXMLv1_11.dtd' "$research_dir/b.fcpxml"
```

The independent verifier checks the fixture's three source ranges, three metadata IDs, title text and negative audio lane. The authored A, independent edit and B pass the installed 1.11 DTD. This does not prove actual Final Cut import, playback, editability, metadata persistence, original-source identity, generalized preservation or native Undo. The existing IR compiler limitations remain.
