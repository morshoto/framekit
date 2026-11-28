# Installed public surface research

From this worktree after frozen dependency installation:

```sh
node --test scripts/research/public-surface/compare.test.mjs
node scripts/final-cut-supported-read-probe.mjs > /tmp/framekit-public-probe.json
node scripts/research/public-surface/compare.mjs tests/fixtures/final-cut-supported-read-probe-10.7.1.json /tmp/framekit-public-probe.json
```

The existing probe reads installed app metadata and scripting declarations plus checked-in Workflow Extension declarations. It does not send an editor command or establish runtime behavior. A missing app produces an unknown result and nonzero status. The comparison is advisory, order-sensitive, and affected by checked-in source as well as the installed app; it does not authenticate input reports or promote canonical capabilities. The prior read-only 10.7.1 build 410082 probe and checked-in baseline had identical SHA-256 `675344d5fdfc4f5cdb038de368d3b61cb97118b37009b37c21faa076dd8baec8`; that is not a comparison with a newer installed version. See [#901](https://github.com/morshoto/framekit/issues/901#issuecomment-7237797583) for candidate/toolchain, source links and the capability matrix.

A matching serialization does not prove original-source identity, proxy exclusion, completeness, target freshness, native mutation/Undo, or receiver terminality. A new declaration also does not prove behavior. Do not launch Final Cut or dispatch an event without independently verified safety prerequisites and separate exact-operation authorization.

Apple's FCPXML documentation distinguishes a resource [`id`](https://developer.apple.com/documentation/professional-video-applications/id), local to a document, from an asset [`uid`](https://developer.apple.com/documentation/professional-video-applications/asset), which can be used to relink the same asset at a different location, and a [`media-rep` `sig`](https://developer.apple.com/documentation/professional-video-applications/media-rep), described as a Final Cut-assigned representation identifier. These identifiers identify different entities; the documentation does not establish an independently authenticated content digest or a timeline occurrence identity. The asset documentation also describes an import case in which a third-party UID replaces a previously Final Cut-assigned asset UID after a URL match. These are documented interchange semantics, not a claim that this installed version was exercised or that arbitrary identities can be safely trusted.

The same `media-rep` documentation says remote media may initially import offline and download in the background. Thus an import-related response alone cannot be assumed to mean all documented media availability work is finished. This does not establish whether any particular response is terminal for any particular Final Cut operation, whether work survives a process exit, or whether the historical reservation involved remote media. The receipt/fencing and original-source questions remain open.

Version update (2026-11-29): Apple's [release notes](https://support.apple.com/en-us/102825) list Final Cut Pro 13.0, released 2026-11-18, and describe FCPXML 1.15. The previous issue matrix's 12.4 as newest is stale. The [current Final Cut Pro 13 guide](https://support.apple.com/guide/final-cut-pro/ver19637ebab/mac) lists macOS 26.6 as its minimum; this machine reports macOS 26.5.1 and the installed app remains 10.7.1 build 410082. This is a documentation comparison, not an installed 13.0 probe or proof that its public APIs, metadata retention, editing, receiver terminality or Undo satisfy Framekit's requirements. No OS or app upgrade was performed or authorized. See #901 for current evidence and limits.
