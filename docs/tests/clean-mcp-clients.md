# Clean Codex and Claude Code MCP Validation

The runner installs the exact published `@morshoto/framekit` version when it is
available and records its npm source commit. If that version is not published,
it installs a locally packed package and records that the public package check
is blocked. A passing local workflow does not turn a missing or mismatched
published package into a release pass. The checked-in
[`2026-08-28-clean-mcp-clients.json`](./evidence/2026-08-28-clean-mcp-clients.json)
is a historical sample, not evidence for the current release candidate.
The [2026-10-24 issue 521 pretag run](../release-evidence/v0.1.18/issue-521-clean-mcp-codex-pretag-2026-10-24.json)
passed the clean Codex MCP and headless workflow at its recorded commit. Its
release-candidate result remains `NO_GO`: v0.1.18 is unpublished, the tested
package and plugin are v0.1.17, and signed native provenance is unavailable.

## What this proves

The validation uses fresh client configuration homes and a temporary package
installation. It hashes every regular file in Codex's isolated installed
plugin directory and compares that digest with the Framekit plugin in the clean
checkout. It records the checkout commit for the plugin only when those bytes
match. It then invokes the installed stdio MCP server through the MCP client
protocol. The workflow checks
connection and editor capability reports, then covers:

1. `headless.project.create` and `headless.project.inspect`;
2. `speech.analyze`;
3. `headless.edit.preview` and `headless.edit.execute`; and
4. `editing.route` to confirm that headless editing was selected.

The workflow uses the deterministic in-memory editor. This proves MCP transport
and headless tool behavior without Final Cut Pro, private media, or model/API
authentication. It records `preflight.fingerprint` when the installed MCP
server reports a full build identity, plus the headless and native Final Cut
capability states. It does not claim that a live Final Cut timeline was edited.

## Supported registration paths

Codex uses the Framekit marketplace and plugin:

```sh
codex plugin marketplace add morshoto/framekit
codex plugin add framekit@framekit
codex mcp list --json
```

The normal user flow is still to open `/plugins`, install **Framekit**, and
start a new Codex session. The MCP server process runs from the installed npm
package; no repository checkout is required for that process.

Claude Code uses a user-scoped local stdio server:

```sh
claude mcp add --env FRAMEKIT_EDITOR=final-cut-live \
  --scope user --transport stdio framekit -- \
  npx -y @morshoto/framekit mcp --headless
claude mcp list
claude mcp get framekit
```

The `--` separator is required so Claude Code passes the server arguments to
Framekit. The tested stable Claude Code version is recorded in the evidence;
the supported version should be refreshed when Anthropic changes the stable
release. The local server command is headless and therefore does not launch,
focus, or mutate Final Cut through Accessibility.

## Run the clean validation

Use the repository's supported Node toolchain. The runner checks npm metadata,
installs the exact published version when available (or packs the checkout for
a local diagnostic), creates isolated Codex and Claude Code configuration
homes, and runs the six-step headless workflow for each selected client:

```sh
nix develop ./nix
pnpm install --frozen-lockfile
pnpm run test:clean-mcp-clients
```

Run one client while diagnosing setup:

```sh
FRAMEKIT_CLEAN_CLIENT=codex pnpm run test:clean-mcp-clients
FRAMEKIT_CLEAN_CLIENT=claude pnpm run test:clean-mcp-clients
```

Use `CLAUDE_BIN` to validate an already-installed Claude Code binary, or let
the runner install the recorded stable version into a temporary directory.
`CLAUDE_CODE_VERSION` overrides that version for a deliberate compatibility
probe. The runner never writes client configuration into the user's normal
home.

## Current limitations and actionable failures

- The published package check is separate from a local packed-package
  workflow. A blocked or mismatched `@morshoto/framekit` lookup is reported with
  an actionable reason and cannot pass the release candidate.
- The bundled Workflow Extension is metadata-only. Live canonical reads,
  timeline edits, read-after-write, diff, verification, and undo remain
  `CAPABILITY_UNAVAILABLE` without a canonical provider such as an explicit
  FCPXML artifact.
- Headless mode does not enable native Final Cut UI writes. Accessibility and
  Automation are only relevant to an explicit headed native-write validation.
- A green deterministic workflow is not evidence that Final Cut is open, the
  Workflow Extension socket is available, or a native mutation succeeded.

Do not replace these limitations with fabricated timeline data or a successful
status. Resolve the setup failure, rerun the clean validation, and review the
sanitized JSON before sharing it.

## Evidence contract

The runner records selected client versions, Framekit and runtime versions,
MCP server/protocol versions, the package source, npm version and source commit,
Codex plugin version, installed-content digest, source digest, and source-bound
commit, MCP build fingerprint, editor
identity, allowlisted capabilities, each required tool result, and sanitized
limitation messages. Release evidence also carries a machine-readable
`releaseCandidate` result. It is `GO` only when the npm package, Codex plugin,
MCP server, and signed Workflow Extension all match the exact release tag and
commit from a clean source checkout; missing or mismatched artifacts are
`NO_GO` with per-artifact reasons. A dirty source checkout always forces
`NO_GO`.
The native release verifier reads the completed release workflow artifact,
checks the downloaded archive checksum and embedded extension build identity,
and records the native packaging job result. It omits private filesystem
paths, raw tool responses, transaction IDs, credentials, and diagnostics.

The checked-in JSON is a historical review artifact, not a claim that the
current public package setup is green. Regenerate it after a public release and
inspect the exact commit fingerprints and `releaseCandidate` status before
marking release validation complete.
