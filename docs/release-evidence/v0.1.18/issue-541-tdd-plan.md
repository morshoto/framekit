# TDD plan: Codex handoff from approved video to Final Cut (#541)

- **Type:** Feature and acceptance work
- **Issue:** [#541](https://github.com/morshoto/framekit/issues/541)
- **Complexity:** High
**TDD entry point:** `tests/integration/codex-plugin.test.ts` checks that the packaged Codex runbook records complete handoff provenance.

## Issue summary

Exercise the installed Framekit plugin and production MCP on one exact checkout and package. Carry the approved headless execution, canonical revision, media and output digests, and new library target through a separately approved native publish, then report success only after matching Final Cut readback.

The publisher contract (#519) and new-project backend (#212) are already merged in #525 and #552. This issue owns Codex-facing execution and evidence; the integrated release verdict remains in #517.

## Issue excerpt

> “Codex carries the approved headless execution ID, canonical revision, source bindings, and verified FCPXML path/digest into `artifact.publish.preview`.”

## Scope

**In scope**

- Capture exact Codex, installed plugin, MCP package/build, Workflow Extension, and Final Cut identities.
- Verify a fresh approved headless workflow and bind its execution, revision, media sources, FCPXML artifact, and destination through publish preview, execute, status, and resume.
- Require separate authorization for Final Cut import and verify created-target, active-project, and timeline semantics.
- Preserve one publish job during interruption and pending verification; link sanitized evidence into #517.

**Out of scope**

- Implementing the publisher backend or changing the publishing contract without a demonstrated regression.
- Editing an existing project or starting an implicit headed fallback.
- Closing #517 or claiming v0.1.18 release readiness.

## Behaviour inventory

| ID | Observable behaviour | Test level | First seam |
| --- | --- | --- | --- |
| B1 | Packaged Codex guidance records exact package identities, approved source/revision, approvals, output hashes, native readback, and recovery evidence | Integration/document contract | `tests/integration/codex-plugin.test.ts` |
| B2 | MCP preview binds the exact headless execution, canonical revision, artifact and source digests, and absent absolute target | Production MCP contract | `tests/integration/headless-project-mcp.test.ts` |
| B3 | Native execution requires separate approval and only reports success after matching created-target and active-project readback | Publisher contract plus headed acceptance | `tests/integration/publisher.test.ts`, then authorized headed run |
| B4 | Unavailable/mismatched capability, rejected approval, stale input, interruption, and pending verification remain bounded and do not duplicate import | Contract and retry tests | `tests/integration/publisher.test.ts`, `tests/integration/runtime-alignment.test.ts` |
| B5 | Sanitized run evidence is linked to #517 without exposing private media, credentials, or user-specific paths | Evidence review | `docs/release-evidence/v0.1.18/issue-541-codex-handoff.md` |
| B6 | Multi-term editorial queries return matching speech ranges across all intended sources | Runtime integration | `tests/integration/semantic-media.test.ts` |
| B7 | Render verification follows the FFmpeg renderer's normalized audio format when source rates differ | Headless render integration | `tests/integration/render-and-verify.test.ts` |

## Test-first implementation cycles

### Cycle 1: Make handoff evidence requirements executable

**Red**

- Add a focused assertion in `tests/integration/codex-plugin.test.ts` for canonical revision, per-source SHA-256, preview digests and approval records, package fingerprints, sanitized transcript, native readback, recovery evidence, and #517 linkage.
- Expected failure: the current runbook's “Record the run” section omits the canonical revision and the other explicit evidence fields.
- Run: `npx --yes pnpm@12.14.0 exec tsx --test tests/integration/codex-plugin.test.ts`.

**Green**

- Update `docs/tests/codex-video-production-e2e.md` and its installed plugin copy with the minimum evidence checklist.
- Do not change the MCP contract or claim native acceptance from documentation.
- Rerun the focused test.

**Refactor**

- Keep the test tied to observable runbook requirements and confirm the plugin copy remains byte-for-byte aligned after its two installable link rewrites.

### Cycle 2: Characterize existing MCP contract and recovery behaviour

**Red**

- Inspect and run the existing exact-source, target-binding, and retry tests. Add a narrowly scoped failing regression only if a #541 requirement is not already proven.
- Expected failure before any production edit: a missing binding, unsafe status, or duplicate import demonstrated by the specific assertion.

**Green**

- Make only the production change required by a confirmed regression. Existing merged #525/#552 behavior is not reimplemented.

**Refactor**

- Rerun the affected MCP and publisher tests before adjusting shared helpers or documentation.

### Cycle 2a: Preserve multi-source rough-cut query matches

**Red**

- Reproduce a Codex query containing terms from three source transcripts; the current whole-query substring filter returns no candidates.
- Add an integration assertion that each source with at least one matching query term appears in the capped plan.

**Green**

- Match entries when any individual query term appears in source identity or semantic text; keep planner term-hit ranking for candidate ordering.
- Document the multi-term query behavior in the plugin skill and production runbook.

**Refactor**

- Confirm the query test and packaged runbook alignment, then rerun semantic-media and Codex plugin tests.

### Cycle 2b: Verify normalized mixed-audio output

**Red**

- Render a valid 22.05 kHz source as the FFmpeg renderer's 48 kHz mono output.
- Expected failure: the verifier incorrectly compares output sample rate with the first source stream's rate.
- Run: `node_modules/.bin/tsx --test tests/integration/render-and-verify.test.ts`.

**Green**

- Validate audio against the renderer's explicit 48 kHz mono output format while still requiring an audio stream when timeline media has audio.
- Rerun the focused render verification test.

**Refactor**

- Keep the check tied to the renderer output contract; source sample rate may differ after mixed audio is resampled.

### Cycle 3: Run the exact-package Codex workflow

- Start a fresh Codex session using the packaged plugin and MCP built from the recorded candidate.
- Run the reference three-video plus separate music workflow with new inputs; historical approvals are not reusable.
- Obtain approval for the exact headless preview before execute. Record the execution ID, canonical revision, digests, and output verification.
- Do not call native execute at this stage.

### Cycle 4: Separately authorized native delivery

- Readiness and the immutable native preview must be established for a new disposable `.fcpbundle` target.
- Present the exact preview and obtain separate user authorization for the import.
- Import once, inspect status for the same job, and verify matching library/event/project/sequence and active-project before/after evidence.
- If verification is pending, resume that job only. Record pending, blocked, failed, and not-run outcomes truthfully.

## Focused and final verification

Focused tests:

```sh
npx --yes pnpm@12.14.0 exec tsx --test tests/integration/codex-plugin.test.ts
npx --yes pnpm@12.14.0 exec tsx --test tests/integration/headless-project-mcp.test.ts tests/integration/publisher.test.ts tests/integration/runtime-alignment.test.ts
```

Final repository validation from this worktree:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run test
pnpm run check:boundaries
```

The headed native run is a separate evidence tier and requires separate authorization for the exact preview and import.

## Risks and mitigations

- **Risk:** package or extension identity does not match the tested checkout. **Mitigation:** record installed-content and build fingerprints; stop if alignment is missing or mismatched.
- **Risk:** historical approval is reused after inputs or code change. **Mitigation:** require a fresh preview digest and approval for the candidate run.
- **Risk:** pending readback causes a duplicate project. **Mitigation:** retain one job ID and record import count across status and resume.
- **Risk:** private paths or media leak into shared evidence. **Mitigation:** retain exact private values locally and sanitize linked transcripts and reports.

## Definition of done

- [ ] Every acceptance criterion has a test or explicit native verification item.
- [ ] Focused tests and required repository validation pass on the exact PR head.
- [ ] Actual Codex/MCP run identities, approvals, source/output hashes, and transcript are recorded.
- [ ] Native success is claimed only after authorized import and matching target readback; otherwise the exact blocker is recorded.
- [ ] Sanitized evidence is linked into #517 and the PR remains open for review.

## Run status

- The installed Codex plugin produced an approved, verified headless MP4 and FCPXML from fresh synthetic media. The first execution exposed B7; the same approved plan passed after the verifier fix.
- Native `artifact.publish.preview` bound the verified execution, FCPXML digest, source digests, and a new `.fcpbundle` target. Headed readiness is blocked because the installed Workflow Extension commit differs from the tested MCP package commit.
- No native import was attempted. A matching extension candidate was built at the exact PR head but not installed; installation/reload, a fresh matched preview, and separate user approval are still required.
- Sanitized transcript and artifact evidence are in `issue-541-codex-transcript.json` and `issue-541-codex-handoff.md`; this PR references #517 for QA follow-up.
