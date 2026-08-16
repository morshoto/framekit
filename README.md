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
- `project.inspect`
- `timeline.inspect`
- `timeline.changes`
- `timeline.edit` (`rename-clip`, `trim-clip`, `set-gain`, `ripple-delete`, and `add-marker`)
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
`FRAMEKIT_EDITOR=final-cut-live` to enable the document surface.

The live bridge uses the shared per-user sandbox endpoint
`~/Library/Containers/com.framekit.finalcut.workflow.extension/Data/framekit.sock`
(or the same explicit `FRAMEKIT_FINAL_CUT_SOCKET` override on both processes). It
exposes live project/sequence metadata, playhead, selected range, and change
events. Full clip/media enumeration, visual analysis, and native asset
discovery remain explicitly unavailable until Final Cut exposes supported
native surfaces or external providers are connected. Editor and analyzer
capabilities are reported separately by `editor.inspect`.

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

The live connection remains read-only and fails closed for capabilities that
Final Cut does not expose through the Workflow Extension.
