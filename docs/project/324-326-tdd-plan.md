# TDD Plan: Headless editing sessions and materialization (#324-#326)

**Type:** Feature

**Issues:** #324, #325, #326

**Complexity:** High

**TDD entry point:** an MCP contract test that cannot discover `session.create`.

## Goal and scope

Expose the existing provider-neutral Timeline IR as durable MCP sessions, bind
read-only Final Cut SQLite observations to session freshness, and turn a clean
session into a resumable FCPXML materialization job. The implementation must not
write Final Cut SQLite databases, overwrite existing projects, or claim native
completion from artifact generation alone.

## Behaviour inventory

| ID | Behaviour | Test level | First test seam |
| --- | --- | --- | --- |
| B1 | Create, inspect, preview, execute, and reload a session | MCP integration | `tests/integration/headless-session-mcp.test.ts` |
| B2 | Reject stale revisions, providers, and invalid persisted documents | MCP integration | `tests/integration/headless-session-mcp.test.ts` |
| B3 | Bind non-canonical SQLite evidence and mark changed observations stale | MCP integration | `tests/integration/headless-session-mcp.test.ts` |
| B4 | Block stale sessions until provider reconciliation succeeds | MCP integration | `tests/integration/headless-session-mcp.test.ts` |
| B5 | Preview and persist an immutable versioned FCPXML job | MCP integration | `tests/integration/materialization-job-mcp.test.ts` |
| B6 | Confirm provider handoff, preserve evidence tiers, and resume blockers | MCP integration | `tests/integration/materialization-job-mcp.test.ts` |

## Test-first cycles

### Cycle 1: Session MCP persistence

- **Red:** assert `session.create`, `session.inspect`, `session.edit.preview`, and
  `session.edit.execute` are discoverable and preserve exact rational values
  across a new server instance.
- **Green:** add an atomic filesystem session repository and minimal MCP tools.
- **Refactor:** centralize schemas and structured session errors while green.

### Cycle 2: Session reconciliation safety

- **Red:** assert stale expected revisions and mismatched providers fail closed;
  assert explicit reconciliation updates state without native mutation.
- **Green:** add status/reconciliation tools and provider validation.
- **Refactor:** share session loading and persistence boundaries.

### Cycle 3: SQLite observation binding

- **Red:** assert unchanged observations remain stable, changed digests mark the
  session possibly stale, and errors do not expose source paths.
- **Green:** add an injected read-only observation provider and session metadata.
- **Refactor:** isolate non-canonical evidence normalization.

### Cycle 4: Materialization artifact checkpoint

- **Red:** assert preview is non-mutating and execute requires confirmation,
  reconciliation, and explicit target identity before staging FCPXML.
- **Green:** add a persistent job repository, deterministic compiler call, atomic
  artifact staging, and versioned collision-safe destination data.
- **Refactor:** separate job state transitions from MCP transport.

### Cycle 5: Provider handoff and recovery

- **Red:** assert unavailable publication becomes resumably blocked, successful
  publication records canonical readback evidence, and restart preserves status.
- **Green:** delegate through an injected publication boundary and checkpoint each
  transition without treating requests as native proof.
- **Refactor:** normalize evidence tiers and errors.

### Cycle 6: Protocol and documentation

- **Red:** update the complete MCP tool contract and documentation assertions.
- **Green:** register all tools in stdio and document configuration/evidence.
- **Refactor:** run affected suites and remove transport duplication.

## Focused commands

```sh
pnpm exec tsx --test tests/integration/headless-session-mcp.test.ts
pnpm exec tsx --test tests/integration/materialization-job-mcp.test.ts
pnpm exec tsx --test tests/integration/mcp.test.ts
```

## Final verification

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run test
pnpm run check:boundaries
```

## Risks and mitigations

- Persisted state may be corrupted or concurrently replaced: validate every read
  and use same-directory atomic rename writes.
- SQLite evidence may be mistaken for canonical state: encode `canonical: false`
  and allow it only to invalidate freshness.
- A publication request may be mistaken for completion: report artifact,
  provider-requested, canonical-readback, and headed-native evidence separately.
- Provider downtime may strand jobs: checkpoint blockers and make status/retry
  safe after process restart.

## Definition of done

- Every behaviour above has a test that was observed red before production code.
- Focused tests and all repository gates pass.
- No direct SQLite writer or coordinate-only UI fallback is introduced.
- A non-draft PR links and closes #324, #325, and #326 without claiming headed
  Final Cut proof that was not run.
