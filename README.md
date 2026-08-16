# Framekit

Agentic video editing runtime. Phase 1 extends the Phase 0 read → write →
read-after-write → diff loop with a Final Cut XML adapter, timeline context,
speech/audio analysis ports, verification, rollback, and MCP stdio tools.

## Development

```sh
npm install
npm test
npm run build
```

The documentation index is in [`docs/README.md`](docs/README.md). The MCP
contract is documented in [`docs/mcp/`](docs/mcp/), and reproducible Phase 0,
Phase 1, and Final Cut live tests are documented in [`docs/tests/`](docs/tests/).

The reproducible Node shell and native toolchain contract live under
[`nix/`](nix/). Enter it with `nix develop ./nix`, then run
`npm run xcode:check` before building the Final Cut Workflow Extension.

## MCP server

The local MCP server uses the deterministic in-memory Phase 0 fixture:

```sh
npm run mcp
```

It exposes these tools over stdio:

- `editor.inspect`
- `project.inspect`
- `timeline.inspect`
- `timeline.changes`
- `timeline.edit` (`rename-clip`, `trim-clip`, `set-gain`, `ripple-delete`, and `add-marker`)
- `media.inspect`
- `media.search`
- `speech.analyze`
- `audio.analyze`
- `visual.analyze` (explicitly unavailable until Phase 2)
- `editor.assets`
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

The live bridge uses the shared `/tmp/framekit-finalcut.sock` endpoint (or the
same explicit `FRAMEKIT_FINAL_CUT_SOCKET` override on both processes). It
exposes live project/sequence metadata, playhead, selected range, and change
events. Full clip/media enumeration remains explicitly unavailable until Final
Cut exposes it through a supported native surface. Editor and analyzer
capabilities are reported separately by `editor.inspect`.

See [`docs/tests/final-cut-live-e2e.md`](docs/tests/final-cut-live-e2e.md) for
the read-only Final Cut validation procedure.
