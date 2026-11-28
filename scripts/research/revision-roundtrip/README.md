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
