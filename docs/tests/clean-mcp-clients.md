# Clean Codex and Claude Code MCP Validation

Status: the client registration and complete MCP workflow pass against a clean
packed Framekit package. The documented public `npx` path remains blocked until
`@morshoto/framekit` is published to npm and a release is available. The
Evidence filenames use the UTC calendar date, matching the date portion of the
ISO-8601 `recordedAt` timestamp. The current sanitized result is
[`2026-08-28-clean-mcp-clients.json`](./evidence/2026-08-28-clean-mcp-clients.json).

## What this proves

The validation uses fresh client configuration homes and does not depend on a
repository checkout for the server process. It checks the documented setup
commands and then invokes the same stdio MCP server through the MCP client
protocol. For each client, the workflow covers:

1. `project.inspect` for a project read;
2. `speech.analyze` for analysis;
3. `timeline.edit` for a verified edit;
4. `edit.diff` for the resulting diff;
5. `edit.verify` for post-edit verification; and
6. `edit.undo` for restoration.

The workflow uses the deterministic in-memory editor from a temporary packed
install. This proves MCP transport and tool behavior without Final Cut Pro,
private media, or model/API authentication. It does not claim that a live
Final Cut timeline was edited.

## Supported registration paths

Codex uses the Framekit marketplace and plugin:

```sh
codex plugin marketplace add morshoto/framekit
codex plugin add framekit@framekit
codex mcp list --json
```

The normal user flow is still to open `/plugins`, install **Framekit**, and
start a new Codex session. No repository checkout is required.

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

Use the repository's Node 22 toolchain. The runner builds a temporary npm
package, installs it into a temporary directory, creates isolated Codex and
Claude Code configuration homes, checks both registration commands, and runs
the six-tool workflow twice:

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

- The published package check is separate from the local packed-package
  workflow. A blocked `@morshoto/framekit` npm lookup must be resolved by
  publishing the package and creating a release before the public `npx` path
  can be called complete.
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

The runner records Codex and Claude Code versions, Framekit and runtime
versions, MCP server/protocol versions, editor identity/version, allowlisted
capabilities, each required tool result, and sanitized limitation messages.
It omits private filesystem paths, raw tool responses, transaction IDs,
credentials, and diagnostics. The evidence sanitizer fails closed if either
client is missing a required workflow step.

The checked-in JSON is a review artifact, not a claim that the current public
package setup is green. Regenerate it after a public release and inspect that
the `publicPackage.status` entries are `passed` before marking this validation
complete.
