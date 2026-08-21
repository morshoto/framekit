# Framekit

Agentic video editing runtime. Phase 2 extends the Phase 0 read → write →
read-after-write → diff loop with incremental context synchronization, visual
analysis, combined media understanding, native asset discovery, and the Phase
1 Final Cut runtime.

## Development

```sh
pnpm install --frozen-lockfile
pnpm run test
pnpm run build
```

The documentation index is in [`docs/README.md`](docs/README.md). The MCP
contract is documented in [`docs/mcp/`](docs/mcp/), and reproducible Phase 0,
Phase 1, and Final Cut live tests are documented in [`docs/tests/`](docs/tests/).

The reproducible Node shell and native toolchain contract live under
[`nix/`](nix/). Enter it with `nix develop ./nix`, then run
`pnpm run xcode:check` before building the Final Cut Workflow Extension.

## MCP server

The local MCP server uses the deterministic in-memory Phase 2 fixture:

```sh
pnpm run mcp
```

It exposes these tools over stdio:

- `connection.status`
- `editor.inspect`
- `editor.native.inspect`, `editor.native.edit`, `editor.native.undo`
- `editor.native.media.search`, `editor.native.media.select`,
  `editor.native.timeline.locate`
- `editor.native.blade.preview`, `editor.native.blade.execute`
- `project.inspect`
- `timeline.inspect`
- `timeline.changes`
- `timeline.edit` (`rename-clip`, `trim-clip`, `set-gain`, `ripple-delete`, and `add-marker`)
- `timeline.publish.new-project` (imports a verified FCPXML artifact as a new
  Final Cut project when native writes are enabled)
- `media.inspect`
- `media.search`
- `speech.analyze`
- `audio.analyze`
- `visual.analyze`
- `media.understand`
- `editor.assets` (queryable native asset registry)
- `context.inspect`
- `context.changes`
- `edit.diff`
- `edit.verify`
- `edit.undo`

The runtime core does not import MCP SDK packages. The stdio server is an
adapter around `AgentVideoRuntime`, as required by the SDD.
`FcpxmlDocumentAdapter` reads and writes an ordered FCPXML interchange
artifact; it does not claim to mutate the open Final Cut session. The
`FinalCutSessionAdapter` composes that snapshot/mutation provider with the
live Workflow Extension provider. Set `FRAMEKIT_FCPXML_PATH` alongside
`FRAMEKIT_EDITOR=final-cut-live` to enable canonical reads, artifact edits,
read-after-write, diffs, verification, and undo.

Final Cut analysis providers can be configured as local JSON commands with
`FRAMEKIT_SPEECH_ANALYZER`, `FRAMEKIT_AUDIO_ANALYZER`, and
`FRAMEKIT_VISUAL_ANALYZER`. Each command receives one JSON request on stdin
and returns one typed JSON result on stdout. Set
`FRAMEKIT_ANALYZER_TIMEOUT_MS` to change the default timeout. Installed Motion
templates are indexed from standard locations; override them with the
colon-separated `FRAMEKIT_FINAL_CUT_ASSET_ROOTS` variable.

The live bridge uses the shared per-user sandbox endpoint
`~/Library/Containers/com.framekit.finalcut.workflow.extension/Data/framekit.sock`
(or the same explicit `FRAMEKIT_FINAL_CUT_SOCKET` override on both processes). It
exposes live project/sequence metadata, playhead, selected range, and change
events. The live Workflow Extension remains read-only; canonical timeline
operations use the explicit FCPXML artifact path. Optional selection-scoped
native UI edits are enabled only with `FRAMEKIT_FINAL_CUT_NATIVE_WRITES=1`
and require macOS Accessibility/Automation permission. Editor, analyzer, and
native capabilities are reported separately by `editor.inspect`.

With native writes enabled, the live UI path can search the active Final Cut
Browser, select a media result, locate a matching timeline occurrence, and
prepare/execute a Blade-at-playhead operation. Media and timeline occurrence
handles are short-lived and fail closed when Final Cut changes. Full canonical
timeline edits remain FCPXML artifact edits; `timeline.publish.new-project`
imports the verified artifact as a new project and never replaces the active
project automatically.

See [`docs/tests/final-cut-live-e2e.md`](docs/tests/final-cut-live-e2e.md) for
the read-only Final Cut validation procedure.

## Connect Codex to Final Cut

Register the local MCP server with Codex:

```sh
codex mcp add framekit -- framekit mcp --editor final-cut-live
```

The live server automatically detects Final Cut Pro, installs a configured
Workflow Extension artifact under the user's Applications directory, activates
it, and reconnects when the socket disappears. Inspect setup progress with:

```sh
framekit doctor finalcut --json
```

For a development checkout, build and connect the native extension in one
command:

```sh
framekit connect finalcut --development
```

The live connection fails closed for capabilities that Final Cut does not
expose through the Workflow Extension. Native UI writes are a separate,
explicitly enabled selection-scoped path.
