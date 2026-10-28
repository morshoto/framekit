# Issue 541 Codex-to-Final Cut handoff evidence

This evidence supports QA follow-up in [#517](https://github.com/morshoto/framekit/issues/517). The fresh headless workflow passed and the production MCP produced an immutable native publish preview. Native delivery is blocked because the installed Workflow Extension does not match the tested MCP build. No FCPXML import was attempted.

The sanitized tool record is [issue-541-codex-transcript.json](./issue-541-codex-transcript.json). `$RUN_ROOT` in that record stands for the unique temporary directory used by this run. Source and output files remain outside the repository.

## Build identities

| Component | Identity |
|---|---|
| Codex CLI | `0.162.1` |
| Installed Framekit plugin | `0.1.17`, content fingerprint `d8cd9e116221b5ec218ff4472575c1da152cac9740d4775ddcd15bdcefdb64e8` |
| Preview and first render attempt | runtime commit `889aa581981ea5ff958f969d8b56b96e449e7a3c`; package SHA-256 `dd9c61e0bf65978e691d5a399a3d3bc8ac97054ec87a6b01d0f25451a746cb08` |
| Verified render and native preview | runtime commit `7bd7feef09b83e8031648ed5da858dc2dd4db2f3`; package SHA-256 `4dd7709d680a62bba6bdf54871ae436974357650de3b16ef436c36cd8d22c558` |
| Installed Workflow Extension | version `0.1.17`, commit `1ebd32f262633cb719b0354ffd5e597397820944` |

The successful render and native preview used the package built from this worktree. The extension commit differs from that package commit, so headed readiness is blocked with `FRAMEKIT_BUILD_ALIGNMENT_MISMATCH`.

## Fresh headless run

The installed plugin registered three synthetic videos and separate synthetic music, then ran speech transcription with VAD. The planner matched the multi-term query across all three sources. It initially ranked B-C-A; only the order changed for the reviewed B-A-C sequence. Returned source ranges and speech evidence were retained.

| Order | Source | Source range | Confidence | Source SHA-256 |
|---|---|---:|---:|---|
| 1 | B | 4.98–13.44 s | 0.9099 | `2794e8b5a85d47077a0c465a38d169799e4771416bc7c25149535e80ecc5f1a3` |
| 2 | A | 9.99–21.48 s | 0.9139 | `f78b374edb127d449a957365ca024068c13f7d5dbc379e4203d61784e1badcf9` |
| 3 | C | 1.98–12.24 s | 0.8797 | `5b48d52e574eaaa4827f5fe8745b391bb3e3f49cd631d417e674925d4e5dde71` |
| — | Music | independent 0–30 s occurrence, −12 dB | — | `fb06f6d923beec03174a80452937f0948dda2c4d8d40deb989888e543cea95ad` |

The preview included the editable title `FrameKit MVP Test` at timeline 0–6 seconds and `sourceAudioPolicy: preserve-and-mix`. Its plan digest was `919d18320ad1c82fccddefe67681b28487e49e8f4e8731de5bdb3295d6e9ed10`; the FCPXML preview digest was `bb038f2d9ad74cfde0e8e2553b5784e75d316bbe426acf5d2c8a6fef3e3a58ed`. The canonical revision was `ir:51528696b288c30f2ce76bbdc674860bee46a6aeebffc85e0b5d1e4f759876fb`, sequence 5. The user approved this exact headless plan. That approval did not authorize a Final Cut import.

The first render attempt used the unchanged approved payload. It wrote a playable MP4, then failed verification because the verifier expected the source AAC rate of 22.05 kHz while the FFmpeg renderer intentionally normalizes mixed audio to 48 kHz mono. The focused regression was red before the verifier fix and green afterward. The failed MP4 was removed before retrying the same approved payload.

The verified retry returned headless execution ID `rough-cut-e280b6e4-7fc1-45b5-b80c-229da1dcab3a` and render ID `render-98b4bd42-6c33-44a8-922a-fe49662ab4fe`. Both artifacts bind to the same canonical revision:

| Artifact | SHA-256 | Verification |
|---|---|---|
| `$RUN_ROOT/output/highlight.mp4` | `92e1b8f419cb39023797b90ee61798167689a75b0d32cbe14e224cebde1a4863` | Passed; H.264, 1280×720, 30 fps, 30.233333 s, AAC 48 kHz mono |
| `$RUN_ROOT/output/highlight.fcpxml` | `bb038f2d9ad74cfde0e8e2553b5784e75d316bbe426acf5d2c8a6fef3e3a58ed` | Passed; 6,007 bytes; editable FCPXML; preview coverage exact with no degraded or unsupported features |

## Native readiness and publish preview

The headed MCP session found Final Cut and the installed Workflow Extension. The target binding provider was available, but readiness returned `blocked` with `FRAMEKIT_BUILD_ALIGNMENT_MISMATCH`: runtime `7bd7feef09b83e8031648ed5da858dc2dd4db2f3` versus extension `1ebd32f262633cb719b0354ffd5e597397820944`.

The non-mutating `artifact.publish.preview` call carried the exact headless execution ID, FCPXML digest, all four source-media digests, and a new absolute target represented here as `$RUN_ROOT/native/Issue 541 Synthetic Handoff.fcpbundle`. It returned publish job `publish-job-9ff084ad-0e32-4e8d-9ff4-8a8b0ecaca38`, `state: awaiting-confirmation`, `confirmationRequired: true`, and `executionMode: headed-only`. Its source proof reported the expected plan digest, source revision, canonical revision, and FCPXML digest; coverage was exact for artifact, project, sequence, resources, roles, primary storyline order, source ranges, editable titles, gain, provenance, and versioned destination.

No `.fcpbundle` was created. `artifact.publish.execute`, publish status, native editing tools, and UI automation were not called. The preview job was not executed or reported as delivered.

After the blocked preview, a matched MCP package and development extension were built at commit `ee8882fde777e0576699914f1416b0d7ca0f2bd4`. The current PR head is `354aef43ff283dd6514b386e011737e5a0b19c4d`. Comparing those commits shows only evidence-document changes after the candidate build, with no runtime or Swift source changes; the candidate still does not carry the exact current PR-head identity. Exact-head alignment has not been verified.

- MCP package: `0.1.17@ee8882fde777e0576699914f1416b0d7ca0f2bd4`, SHA-256 `27f2779a0a119e7725f40b9666e05f467c278afeb3ac833e730fa174fb839aa6`.
- Workflow Extension app: build identity `0.1.17@ee8882fde777e0576699914f1416b0d7ca0f2bd4`, candidate archive SHA-256 `3ec01ad09a647a26218c6f66bb799f7ad455ee04c2d147b841b7c15a0c89af0f`.
- `pnpm run xcode:check`, `xcodebuild -list`, the Debug app build, and `codesign --verify --deep --strict` passed. The local app uses ad-hoc signing; it is a development candidate, not signed release evidence.

The candidate has not been installed. Installing through Framekit's development connector can gracefully close and reopen Final Cut. After explicit approval, run the connector from the current PR checkout so the MCP runtime and extension are built from the same exact commit, then verify readiness and create a fresh immutable publish preview. A separate approval of that exact native import is still required before headed readback can be collected.

## Validation and implementation

- Added multi-term rough-cut query coverage and documented per-term planner matching.
- Added a regression for source audio resampling; verification now checks the FFmpeg renderer's 48 kHz mono output contract and still fails when required audio is absent.
- Full suite after the verifier change: 1,365 tests, 1 skipped, 0 failures (1,364 passed).
- Build and package boundaries passed in the commit hook. Final required repository validation is recorded on the PR head.
