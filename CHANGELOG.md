# Changelog

## [v0.1.8](https://github.com/morshoto/framekit/compare/v0.1.7...v0.1.8) - 2026-09-12

### ✨ Features
- test: strengthen canonical headed safety evidence by @morshoto in https://github.com/morshoto/framekit/pull/244
- test: guard unsupported native project APIs by @morshoto in https://github.com/morshoto/framekit/pull/246
### 🐛 Fixes
- fix: keep Swift CodeQL check present by @morshoto in https://github.com/morshoto/framekit/pull/232
- fix: return media-specific search unavailability by @morshoto in https://github.com/morshoto/framekit/pull/239
- test: complete Basic Editing MVP evaluation by @morshoto in https://github.com/morshoto/framekit/pull/245
- fix: align live MCP runtime (#234) by @morshoto in https://github.com/morshoto/framekit/pull/241
- fix: fail fast when release runner unavailable by @morshoto in https://github.com/morshoto/framekit/pull/243
- fix: Align metadata-only project inspection capabilities by @morshoto in https://github.com/morshoto/framekit/pull/240
### 🧰 Maintenance & Internal
- chore: group generated release notes by change type by @morshoto in https://github.com/morshoto/framekit/pull/238
- chore: generate milestone release reports by @morshoto in https://github.com/morshoto/framekit/pull/242
- chore: collapse maintenance release notes by @morshoto in https://github.com/morshoto/framekit/pull/247

## [v0.1.7](https://github.com/morshoto/framekit/compare/v0.1.6...v0.1.7) - 2026-09-12

- fix: build and upload native release assets by @morshoto in https://github.com/morshoto/framekit/pull/221
- fix: fail closed on empty native title discovery by @morshoto in https://github.com/morshoto/framekit/pull/219
- feat: import video directories via MCP by @morshoto in https://github.com/morshoto/framekit/pull/220
- fix: preserve native Browser search failures in media targeting by @morshoto in https://github.com/morshoto/framekit/pull/225
- fix: make native Browser search discovery reliable by @morshoto in https://github.com/morshoto/framekit/pull/222
- fix: align generic transition discovery with native identities by @morshoto in https://github.com/morshoto/framekit/pull/218
- feat: resolve native media import and append intents by @morshoto in https://github.com/morshoto/framekit/pull/224
- feat: enable canonical timeline.edit in headed Final Cut by @morshoto in https://github.com/morshoto/framekit/pull/223
- test: add headed rough-cut MCP acceptance gate (#217) by @morshoto in https://github.com/morshoto/framekit/pull/226
- fix: reject false native timeline focus by @morshoto in https://github.com/morshoto/framekit/pull/228
- fix: expand native media home paths by @morshoto in https://github.com/morshoto/framekit/pull/229
- fix: make native media import diagnostics actionable by @morshoto in https://github.com/morshoto/framekit/pull/231
- fix: guide directory media import errors by @morshoto in https://github.com/morshoto/framekit/pull/230

## [v0.1.6](https://github.com/morshoto/framekit/compare/v0.1.5...v0.1.6) - 2026-09-11

- fix: make tagged release retries idempotent by @morshoto in https://github.com/morshoto/framekit/pull/163
- Implement dialogue-normalization Skill by @morshoto in https://github.com/morshoto/framekit/pull/188
- feat: implement filler-removal Skill by @morshoto in https://github.com/morshoto/framekit/pull/189
- Discover built-in Final Cut Motion titles by @morshoto in https://github.com/morshoto/framekit/pull/190
- feat: add native masking capability by @morshoto in https://github.com/morshoto/framekit/pull/191
- feat: add native picture-in-picture by @morshoto in https://github.com/morshoto/framekit/pull/192
- [Improvement] Add the v0.1.6 native-editing release gate by @morshoto in https://github.com/morshoto/framekit/pull/193
- feat: produce sanitized headed-native evidence by @morshoto in https://github.com/morshoto/framekit/pull/196
- fix: sanitize staged commits and repair release gate by @morshoto in https://github.com/morshoto/framekit/pull/198
- feat: Enable headed canonical Final Cut provider by @morshoto in https://github.com/morshoto/framekit/pull/197
- fix: reject out-of-bounds ripple-delete ranges (#199) by @morshoto in https://github.com/morshoto/framekit/pull/201
- test: cover canonical live MCP boundary (#194) by @morshoto in https://github.com/morshoto/framekit/pull/200

## [v0.1.5](https://github.com/morshoto/framekit/compare/v0.1.4...v0.1.5) - 2026-09-11

- test: align pnpm lockfile assertion by @morshoto in https://github.com/morshoto/framekit/pull/174
- fix: exclude audio-only rough-cut shots by @morshoto in https://github.com/morshoto/framekit/pull/170
- fix: reject non-positive rational trim durations by @morshoto in https://github.com/morshoto/framekit/pull/171
- fix: reject inverted analysis ranges by @morshoto in https://github.com/morshoto/framekit/pull/169
- fix: invalidate cached media understanding after edits by @morshoto in https://github.com/morshoto/framekit/pull/175
- fix: reject stale edit.undo by @morshoto in https://github.com/morshoto/framekit/pull/168
- perf: run CodeQL only for affected languages by @morshoto in https://github.com/morshoto/framekit/pull/177
- fix: Expose operation-specific requirements in single-edit MCP schemas by @morshoto in https://github.com/morshoto/framekit/pull/173
- feat: add revision-bound speech and VAD analysis by @morshoto in https://github.com/morshoto/framekit/pull/176
- fix: align MCP server version with package by @morshoto in https://github.com/morshoto/framekit/pull/172
- fix: decouple edits from optional analyzers by @morshoto in https://github.com/morshoto/framekit/pull/180
- fix: preserve analyzer-provider provenance by @morshoto in https://github.com/morshoto/framekit/pull/179
- fix: preserve media roles in canonical clips by @morshoto in https://github.com/morshoto/framekit/pull/178
- fix: preserve routed capabilities and preflight by @morshoto in https://github.com/morshoto/framekit/pull/183
- fix: make FCPXML publishing state-driven by @morshoto in https://github.com/morshoto/framekit/pull/182
- perf: advertise music.add cross-field constraints by @morshoto in https://github.com/morshoto/framekit/pull/181

## [v0.1.4](https://github.com/morshoto/framekit/compare/v0.1.3...v0.1.4) - 2026-09-10

- feat: add guarded native Final Cut transitions by @morshoto in https://github.com/morshoto/framekit/pull/142
- test: add deterministic Basic Editing MVP gate by @morshoto in https://github.com/morshoto/framekit/pull/143
- test: add live project selection acceptance gate by @morshoto in https://github.com/morshoto/framekit/pull/144
- test: require explicit targets in live canonical evidence by @morshoto in https://github.com/morshoto/framekit/pull/145
- chore(deps): update github actions by @renovate[bot] in https://github.com/morshoto/framekit/pull/160
- chore(deps): update pnpm to v12 by @renovate[bot] in https://github.com/morshoto/framekit/pull/161

## [v0.1.3](https://github.com/morshoto/framekit/compare/v0.1.2...v0.1.3) - 2026-09-08

- chore(deps): pin dependencies by @renovate[bot] in https://github.com/morshoto/framekit/pull/122
- chore: automerge pinned dev dependencies by @morshoto in https://github.com/morshoto/framekit/pull/123
- chore(deps): update dependency @types/node to v24 by @renovate[bot] in https://github.com/morshoto/framekit/pull/126
- chore(deps): update pnpm to v11.24.0 by @renovate[bot] in https://github.com/morshoto/framekit/pull/125
- fix(ci): use packageManager pnpm version in assign workflow by @morshoto in https://github.com/morshoto/framekit/pull/127
- fix: recover tagged npm releases by @morshoto in https://github.com/morshoto/framekit/pull/129
- fix(ci): use packageManager pnpm version across workflows by @morshoto in https://github.com/morshoto/framekit/pull/128
- perf: streamline Swift CodeQL extraction by @morshoto in https://github.com/morshoto/framekit/pull/131
- chore(deps): pin dependencies by @renovate[bot] in https://github.com/morshoto/framekit/pull/121
- chore(deps): update dev dependencies by @renovate[bot] in https://github.com/morshoto/framekit/pull/146
- feat: define the editor-independent Skill contract by @morshoto in https://github.com/morshoto/framekit/pull/148
- feat: resolve Skill requirements against runtime capabilities by @morshoto in https://github.com/morshoto/framekit/pull/149
- feat: add the generic Skill runtime by @morshoto in https://github.com/morshoto/framekit/pull/150
- feat: route generic Skill tools through the runtime by @morshoto in https://github.com/morshoto/framekit/pull/151
- feat: add the v0.0.2 Skill conformance gate by @morshoto in https://github.com/morshoto/framekit/pull/152
- feat: add the audio noise reduction Skill by @morshoto in https://github.com/morshoto/framekit/pull/153
- feat: add the basic color correction Skill by @morshoto in https://github.com/morshoto/framekit/pull/154
- chore(deps): lock file maintenance by @renovate[bot] in https://github.com/morshoto/framekit/pull/155
- chore(deps): update pnpm to v11.25.0 by @renovate[bot] in https://github.com/morshoto/framekit/pull/147
- chore(deps): update dependency typescript to v7 by @renovate[bot] in https://github.com/morshoto/framekit/pull/156
- docs: add deep wiki navigation without deleting content by @morshoto in https://github.com/morshoto/framekit/pull/61
- chore(deps): update github actions (major) by @renovate[bot] in https://github.com/morshoto/framekit/pull/157
- feat: add repository agent workflow skills by @morshoto in https://github.com/morshoto/framekit/pull/158

## [v0.1.2](https://github.com/morshoto/framekit/compare/v0.1.1...v0.1.2) - 2026-08-30

- chore: run Renovate daily at 7am by @morshoto in https://github.com/morshoto/framekit/pull/106
- ci: preserve default-branch CodeQL analyses by @morshoto in https://github.com/morshoto/framekit/pull/111
- [Fix] Fail closed on untrusted live snapshots by @morshoto in https://github.com/morshoto/framekit/pull/112
- [Improvement] Harden sanitized headed evidence digests by @morshoto in https://github.com/morshoto/framekit/pull/113
- fix: guard npm release publishing by @morshoto in https://github.com/morshoto/framekit/pull/114
- fix: preserve partial filler analysis ranges by @morshoto in https://github.com/morshoto/framekit/pull/117
- chore(deps): lock file maintenance by @renovate[bot] in https://github.com/morshoto/framekit/pull/116
- chore: enable Renovate automerge for safe updates by @morshoto in https://github.com/morshoto/framekit/pull/120
- feat: add deterministic filler safe cuts by @morshoto in https://github.com/morshoto/framekit/pull/118
- feat: add v0.0.3 speech editing release gate by @morshoto in https://github.com/morshoto/framekit/pull/119
- ci: restore reliable Swift CodeQL coverage by @morshoto in https://github.com/morshoto/framekit/pull/115

## [v0.1.1](https://github.com/morshoto/framekit/compare/v0.1.0...v0.1.1) - 2026-08-30

- chore: automate npm and GitHub releases by @morshoto in https://github.com/morshoto/framekit/pull/84
- docs: improve README onboarding by @morshoto in https://github.com/morshoto/framekit/pull/93
- chore: move PR labeling rules to YAML by @morshoto in https://github.com/morshoto/framekit/pull/94
- refactor(runtime): split runtime responsibilities by @morshoto in https://github.com/morshoto/framekit/pull/95
- feat: define editorial duration policy by @morshoto in https://github.com/morshoto/framekit/pull/96
- [Improvement] Make Framekit MCP workflow routing editor-first by @morshoto in https://github.com/morshoto/framekit/pull/97
- feat: add semantic media understanding by @morshoto in https://github.com/morshoto/framekit/pull/98
- feat: expose operation-level capability discovery by @morshoto in https://github.com/morshoto/framekit/pull/99
- feat: assert semantic verification outcomes by @morshoto in https://github.com/morshoto/framekit/pull/100
- feat: add rough-cut project construction primitives by @morshoto in https://github.com/morshoto/framekit/pull/101
- chore: issue tempalte tags by @morshoto in https://github.com/morshoto/framekit/pull/105
- feat: separate artifact and live edits by @morshoto in https://github.com/morshoto/framekit/pull/102

## [v0.1.0](https://github.com/morshoto/framekit/commits/v0.1.0) - 2026-08-30

### Features
- feat: categorize release notes from PR titles by @morshoto in https://github.com/morshoto/framekit/pull/83
### Other Changes
- Context engine and final cut pro bridge adaptor by @morshoto in https://github.com/morshoto/framekit/pull/1
- Revise README for clarity and updated instructions by @morshoto in https://github.com/morshoto/framekit/pull/19
- fix: recover native Final Cut edits from focus races by @morshoto in https://github.com/morshoto/framekit/pull/18
- docs: define basic Final Cut editing MVP contract by @morshoto in https://github.com/morshoto/framekit/pull/20
- feat: add deterministic MCP editing evaluation suite by @morshoto in https://github.com/morshoto/framekit/pull/21
- feat: understand and select active Final Cut projects by @morshoto in https://github.com/morshoto/framekit/pull/22
- feat: add reliable Final Cut media targeting by @morshoto in https://github.com/morshoto/framekit/pull/25
- fix: prevent Final Cut popup during pre-commit validation by @morshoto in https://github.com/morshoto/framekit/pull/29
- [Feature] Add an explicit editing intent layer by @morshoto in https://github.com/morshoto/framekit/pull/26
- feat: import local media into Final Cut by @morshoto in https://github.com/morshoto/framekit/pull/27
- feat: add native media insertion operations by @morshoto in https://github.com/morshoto/framekit/pull/28
- fix: reject cross-target restore and undo by @morshoto in https://github.com/morshoto/framekit/pull/48
- fix: preserve imported media handles across searches by @morshoto in https://github.com/morshoto/framekit/pull/47
- fix: keep FCPXML project identities stable by @morshoto in https://github.com/morshoto/framekit/pull/49
- feat: implement composite Basic Final Cut Editing MVP transactions by @morshoto in https://github.com/morshoto/framekit/pull/51
- feat: distribute Framekit as a Codex plugin by @morshoto in https://github.com/morshoto/framekit/pull/53
- feat: capture and understand timeline frames by @morshoto in https://github.com/morshoto/framekit/pull/50
- feat: add canonical live Final Cut provider contract by @morshoto in https://github.com/morshoto/framekit/pull/52
- chore: set up Renovate by @morshoto in https://github.com/morshoto/framekit/pull/58
- fix: harden canonical live Final Cut provider by @morshoto in https://github.com/morshoto/framekit/pull/55
- feat: add guarded music mixing workflow by @morshoto in https://github.com/morshoto/framekit/pull/54
- [Feature] Export and verify the final video by @morshoto in https://github.com/morshoto/framekit/pull/56
- feat: add native titles by @morshoto in https://github.com/morshoto/framekit/pull/57
- test: harden Phase 0 and Phase 1 contracts by @morshoto in https://github.com/morshoto/framekit/pull/73
- [Improvement] Add sanitized headed evidence for native Final Cut mutation by @morshoto in https://github.com/morshoto/framekit/pull/71
- docs: add Discord shield to README by @morshoto in https://github.com/morshoto/framekit/pull/74
- [Improvement] Establish a golden workflow corpus and zero-corruption gate by @morshoto in https://github.com/morshoto/framekit/pull/72
- [Bug] Fix headed E2E Framekit overlay window detection by @morshoto in https://github.com/morshoto/framekit/pull/77
- chore: Update pull_request_template.md by @morshoto in https://github.com/morshoto/framekit/pull/81
- [Improvement] Measure the PRD 95% filler-removal verification target by @morshoto in https://github.com/morshoto/framekit/pull/75
- [Improvement] Validate clean MCP clients by @morshoto in https://github.com/morshoto/framekit/pull/76
- [Feature] Complete the live Final Cut filler-removal loop by @morshoto in https://github.com/morshoto/framekit/pull/78
- [Feature] Expose a canonical timeline snapshot for the open Final Cut project by @morshoto in https://github.com/morshoto/framekit/pull/79
- feat: prove disposable native Final Cut edits by @morshoto in https://github.com/morshoto/framekit/pull/80
- chore: updating github labels for tagpr by @morshoto in https://github.com/morshoto/framekit/pull/82
