# Getting Started

Framekit is an agentic video editing runtime. Phase 2 extends the Phase 0
read → write → read-after-write → diff loop with incremental context
synchronization, visual analysis, combined media understanding, native asset
discovery, and the Phase 1 Final Cut runtime.

## Development setup

Install the JavaScript dependencies and run the deterministic checks from the
repository root:

```sh
pnpm install --frozen-lockfile
pnpm run hooks:install
pnpm run test
pnpm run build
pnpm run check:boundaries
```

The reproducible Node shell and native toolchain are provided by the
repository's Nix shell:

```sh
nix develop ./nix
pnpm run xcode:check
```

See [Contributing](../CONTRIBUTING.md) for repository layout, native build
checks, and commit-hook behavior.

## Run the local MCP server

The default server uses the deterministic in-memory Phase 2 fixture and
exposes the runtime over stdio:

```sh
pnpm run mcp
```

The complete tool inventory, including canonical timeline tools, analysis,
context, verification, and native Final Cut tools, is documented in
[MCP tools](./mcp/tools.md). The runtime core remains editor-independent; MCP
is an adapter around it.

For a live Final Cut session, select the live backend explicitly:

```sh
FRAMEKIT_EDITOR=final-cut-live pnpm run mcp
```

The live backend reports its capabilities separately. Live Workflow Extension
state includes project/sequence metadata, playhead, selected range, and change
events, but it is not a complete canonical timeline snapshot. Unsupported
operations fail closed with an explicit capability error. See the
[compatibility matrix](./COMPATIBILITY.md) and [live Final Cut guide](./mcp/final-cut-live.md).

## Canonical documents and analysis providers

Set `FRAMEKIT_FCPXML_PATH` with `FRAMEKIT_EDITOR=final-cut-live` to enable
canonical project and timeline reads, FCPXML artifact edits,
read-after-write, diffs, verification, and undo. The FCPXML artifact is
managed explicitly; Framekit does not silently replace the open Final Cut
project.

Optional local JSON analysis providers are configured with:

- `FRAMEKIT_SPEECH_ANALYZER`
- `FRAMEKIT_AUDIO_ANALYZER`
- `FRAMEKIT_VISUAL_ANALYZER`

Each command receives one JSON request on stdin and returns one typed JSON
result on stdout. Set `FRAMEKIT_ANALYZER_TIMEOUT_MS` to change the default
timeout. Motion templates are discovered from standard locations; restrict
those locations with the colon-separated `FRAMEKIT_FINAL_CUT_ASSET_ROOTS`
variable. The complete provider setup is documented in the
[Final Cut installation guide](./final-cut/installation.md).

## Connect Codex to Final Cut

Register the local MCP server with Codex in headless mode:

```sh
codex mcp add framekit -- framekit mcp --editor final-cut-live --headless
```

Headless mode probes an already-running Workflow Extension socket. It does
not launch, activate, focus, or edit Final Cut through Accessibility. It is
appropriate for live metadata reads and FCPXML artifact work; native UI edit
contracts are validated by the deterministic headless suite.

For normal development mode, build and connect the native extension with:

```sh
framekit connect finalcut --development
```

Inspect automatic setup and reconnect progress with:

```sh
framekit doctor finalcut --json
```

The live bridge uses the per-user socket at
`~/Library/Containers/com.framekit.finalcut.workflow.extension/Data/framekit.sock`.
Use `FRAMEKIT_FINAL_CUT_SOCKET` to provide the same explicit socket path to
both processes. The Workflow Extension remains read-only for canonical
timeline operations. Selection-scoped native UI edits require
`FRAMEKIT_FINAL_CUT_NATIVE_WRITES=1` plus macOS Accessibility and Automation
permission; see [live Final Cut operations](./mcp/final-cut-live.md).
