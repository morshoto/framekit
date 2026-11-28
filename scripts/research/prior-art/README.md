# Prior-art source research

This probe reads Git objects only; it does not install, patch, inject, re-sign, build or run either external application. From this worktree, with two existing local Git repositories containing the pinned commits:

```sh
node --test scripts/research/prior-art/inspect.test.mjs
node scripts/research/prior-art/inspect.mjs /path/to/SpliceKit /path/to/CommandPost
```

The inspector reads SpliceKit commit `3bb929a4681c0225db19a51b2fb9931fea2c2522` and CommandPost commit `54750e571a427340775028a75e10d17ae0c58f34` directly using `git show`. Selected string anchors and source digests are useful review aids, not semantic proof of control flow, runtime compatibility, source identity, completeness, safe Undo, crash behavior or receiver terminality; absence of an anchor does not prove absence of a feature. The pinned source was also manually reviewed in [#904](https://github.com/morshoto/framekit/issues/904#issuecomment-7237920998), with [security and maintenance limits](https://github.com/morshoto/framekit/issues/904#issuecomment-7238245298).

No private injection, app modification, security-control change, native dispatch or access to an existing reservation is authorized by these commands. A separately reviewed environment and exact-operation authorization are required before any live follow-up.
