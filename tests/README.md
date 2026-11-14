# Test suites

`pnpm test` is the required PR aggregate. It executes every reviewed `.test.ts`
and `.test.mjs` file under `tests/`, `packages/`, `apps/`, and `adapters/`, except
for the explicit boundaries below. `test:fast` is a local feedback option.
Install the locked contributor toolchain with `pnpm install --frozen-lockfile`.

## Focused execution

The suite aliases below use the isolated runner:

```sh
pnpm test --file tests/runtime/editing/project-transactions.test.ts
pnpm test --file tests/tooling/ci/ci-workflow.test.mjs --test-name-pattern 'aggregate'
pnpm test unit --file packages/runtime/test/project-store.test.ts
pnpm run test:watch --file tests/runtime/editing/generated-sequences.test.ts
pnpm test headless --check-only
```

Repeat `--file` to select multiple files; exact positional file paths also work.
Name filtering accepts a regular expression. Unknown arguments, unregistered
files, empty selections, and name filters matching no tests fail clearly.
Watch mode reruns the same selection and removes its isolated state on exit.

Aggregate, focused, and watch runs share a read-only sentinel HOME, writable
state/cache/temp directories, and forced fixture/headless settings with native
writes and automatic connection disabled. An inherited headed library opt-in
is disabled too. The runner forwards termination to the test subprocess and
cleans its state after success, failure, or watch termination.

| Command | Reviewed selection |
| --- | --- |
| `pnpm test` | All shared/owner-local tests, including documentation and CI policies. |
| `pnpm run test:fast` | Unit, contract, and critical integration tags, with reviewed deep-test exclusions. |
| `pnpm run test:unit` | Unit tag across shared and owner-local tests. |
| `pnpm run test:contracts` | MCP schema, protocol, capability, and service contract tags. |
| `pnpm run test:fixtures` | Fixture-backed workflow tags. |
| `pnpm run test:integration` | Existing integration selection, independent of physical directories. |
| `pnpm run test:headless` | Headless render and rough-cut tags; no Final Cut process required. |
| `pnpm run test:native` | Final Cut adapter simulations and platform SDK contracts; inspect evidence metadata. It does not launch Final Cut. |
| `pnpm run test:package` | Package contents and clean clients; builds one archive and retains clean local/global installs. |
| `pnpm run test:release-gate` | Gate, provenance, historical release, and evidence contracts. |
| `pnpm run test:golden` | Versioned golden workflow corpus. |
| `pnpm run test:filler-removal` | Filler-removal workflows and benchmark contracts. |
| `pnpm run test:documentation` | Shared documentation and CI policy `.mjs` tests. |

Prerequisites come from the selected manifest entries. They include ffmpeg,
ffprobe, npm/pnpm, Git, Python, and platform tools where actually used; SDK
requirements such as `xcrun` apply only on the declared platform. Package clean
installs require registry network access. `FRAMEKIT_TEST_OFFLINE=1` explicitly
blocks selections declaring network requirements. File-level prerequisites
still apply when a name filter selects only part of a file.

## Placement and discovery

Place a shared test by its primary assertion target:

- `runtime/{editing,projects,timeline,media,audio,verification}`: runtime rules.
- `mcp/{tools,sessions,transport}`: MCP tool and transport contracts.
- `adapters/{final-cut,headless}`: editor/renderer adapter contracts.
- `cli/` and `distribution/`: CLI behavior, launcher, package contents, clean installs.
- `workflows/{basic-editing,filler-removal,dialogue-normalization,rough-cut,golden,evaluation}`: scenarios crossing components.
- `release/{gate,report,acceptance}`: orchestration/provenance, report generation,
  and historical versioned acceptance respectively.
- `tooling/{ci,git,validation,docs,skills}`: repository automation and policies.
- `speech/`: speech analyzer contracts.

Keep domain-local helpers beside their consumers. Put genuinely shared
utilities under `support/<domain>` and inputs under `fixtures/<domain>`;
reusable editor/analyzer fakes belong in `packages/testkit`. Do not duplicate
one test across directories to express multiple capabilities. Use descriptive
capability names, retaining version context for historical acceptance.

Owner-local tests remain under their packages/apps/adapters. The Docs app is
excluded from the root runner: its Vitest runner owns `src/**/*.test.tsx` and
`src/**/*.spec.ts`; its export runner owns `test/*.test.mjs`; Playwright owns
`e2e/*.spec.mjs`. The `docs-changes` CI job separately executes the tool-owned
`scripts/docs-ci-paths.test.mjs`. Root discovery does not traverse `scripts/`,
`tests/research/`, `.codex/`, dependencies, build outputs, or coverage outputs.
Research is explicitly opt-in. Symlinked directories are not traversed.

Release command implementation lives under `scripts/release/{gate,acceptance}`;
the evaluation and benchmark harnesses live under `scripts/evaluation` and
`scripts/benchmarks`. Historical corpora/manifest inputs have explicit domain
owners and are resolved relative to module URLs. Existing command names,
report schemas, provenance checks, and evidence eligibility remain intact.

The reviewed migration map, suite baseline, and declared test identities are
in `support/testing/relocations.json`. Regression tests check that previous
suite members still execute exactly once and preserve their test identities,
with explicit additions, the former headed-test alias, and upstream contract
replacements recorded separately.

## Adding or moving a test

1. Start with an observable failing behavior at the smallest useful seam.
2. Choose the primary responsibility directory and appropriate local fixtures.
3. Run `pnpm run test:inventory:update`. Existing metadata is preserved; new
   entries are unreviewed and block execution until reviewed.
4. Review owner, overlapping tags, evidence, dependencies, executable and
   conditional prerequisites, platforms, network use, and any expected skips.
   Set `reviewed` only after checking those contracts. Folder/file names do not
   establish test level or native evidence. Duplicate/unregistered tests fail.
5. Run focused tests, then the full required repository gates. When relocating
   a test, update imports, module-relative inputs, direct CI paths, commands,
   and the reviewed migration map. Script checks also validate focused paths.

## Timings, coverage, skips, and reproductions

CI retains JUnit, JSON totals, selected-file/toolchain/commit metadata, slowest
tests, seed replay diagnostics, and reviewed skip classifications. Expected
platform/opt-in skips must have the exact reviewed reason and environment;
missing or unreviewed reasons are reported as unexpected. Interrupted reports
remain incomplete. Raw V8 temporary data is used for reporting rather than
uploaded with the compact results.

PR summaries expose an initial per-package branch-coverage baseline and
critical persistence/recovery files. Coverage includes unvisited source files;
it has no arbitrary global threshold. Run `pnpm run test:coverage` locally.
The CI `coverage:report` command consumes the aggregate run's raw V8 data and
retains JSON coverage details, including when tests fail. Docs Vitest remains
an independent coverage surface. Instrumentation counts do not prove the
semantics of each branch or any headed-native behavior.

Generated tests use four fixed seeds and an independent integer-tick oracle.
They cover transaction rejection without mutation, write/rename faults,
revision advancement, rational timing, source identity, and supported
execute/Undo restoration. Replay a failing seed with:

```sh
FRAMEKIT_TEST_SEED=733 pnpm test --file tests/runtime/editing/generated-sequences.test.ts
```

Failures print the seed and operation prefix into retained diagnostics. Reduce
any discovered failure to its necessary operations and retain that regression
beside the domain test before changing the seed set. Existing fault-injection
tests and representative real subprocess/deadline tests remain required.
Render consumers reuse worker-local immutable generated media through independent
copies; source-mutation/race cases retain separate writable inputs. The fixture
generator still has its own direct contract test. Launcher behavioral tests also check that an intentional precedence regression
is detected.

Fixture contracts, macOS SDK checks, extension builds, and headed Final Cut
acceptance are distinct guarantees. Headed `test:final-cut-*-headed` commands
require separate authorization, macOS/Final Cut, and documented target-bound
configuration. Ordinary deterministic tests never establish headed acceptance.
