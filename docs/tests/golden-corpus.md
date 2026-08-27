# Golden Workflow Corpus

The versioned corpus at [`tests/golden/corpus.json`](../../tests/golden/corpus.json)
is the deterministic zero silent corruption gate for supported Phase 0/1
workflows. It uses the in-memory editor fixture; it does not claim native Final
Cut coverage.

Run the corpus alone with:

```sh
pnpm run test:golden
```

The regular repository test command includes the same gate:

```sh
pnpm run test
```

## Coverage

The initial corpus covers:

- clip rename, trim, and gain edits;
- ripple-delete and marker workflows;
- media import, video/music placement, and title placement;
- media references, captions, markers, story elements, and exact revisions.

Each scenario stores its fixture, ordered operation(s), before and after
snapshots, exact diff, and expected revision transitions. The runner checks
structural identity and media-reference validity, preview non-mutation,
read-after-write state, successful undo, forced-verification rollback, and
stale-write rejection without mutation. Node test names include the scenario ID
so CI failures identify the affected workflow.

Native Final Cut capabilities and subjective perceptual quality remain outside
this deterministic gate and require their separately documented validation.

When extending the corpus, add a scenario with independently reviewed expected
state and diff data. Do not replace expected evidence with values recomputed by
the assertion path.
