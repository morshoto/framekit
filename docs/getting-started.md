# Getting started

Framekit can run as a local MCP server for deterministic headless editing or
connect to an explicitly configured Final Cut provider. Start with the
headless fixture; it does not launch or activate Final Cut Pro.

## Development setup

Requirements are Node.js 20 or newer and the repository-pinned pnpm version.
Xcode 16.4 with the macOS 15.5 SDK is required only for native extension work.
For the pinned shell toolchain, enter the optional Nix environment first:

```sh
nix develop ./nix
```

Install and validate from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run hooks:install
pnpm run build
pnpm run test
pnpm run check:boundaries
pnpm run check:docs
```

The test and native evidence levels are described in [Testing](./testing.md).
Repository responsibilities and dependency direction are described in
[Architecture](./architecture.md).

## Run Framekit locally

Start the deterministic in-memory MCP server from the repository root:

```sh
pnpm run mcp
```

For a development Final Cut connection, set the editor explicitly:

```sh
FRAMEKIT_EDITOR=final-cut-live pnpm run mcp
```

`FRAMEKIT_EDITOR` selects the configured backend. `FRAMEKIT_FCPXML_PATH` names
an explicit FCPXML artifact; it does not enable mutation of the open Final Cut
project. `FRAMEKIT_FINAL_CUT_SOCKET` selects the local Workflow Extension
socket. Inspect the reported capabilities before choosing an operation. A
ready metadata-only bridge does not imply canonical timeline read or write.

### Optional analysis providers

Optional local analysis commands are selected with
`FRAMEKIT_SPEECH_ANALYZER`, `FRAMEKIT_AUDIO_ANALYZER`,
`FRAMEKIT_VISUAL_ANALYZER`, and `FRAMEKIT_METADATA_ANALYZER`. Each provider
receives one JSON request on standard input and returns a typed JSON result on
standard output. `FRAMEKIT_ANALYZER_TIMEOUT_MS` changes the bounded provider
timeout. Missing providers report unavailable analysis; they do not invent
media descriptions.

Use `connection.status` for connection diagnostics, `editor.inspect` for
backend and capability details, and `editing.route` for the requested
operation's selected path. Unsupported operations return a structured
unavailable result. The headless path does not launch, activate, or focus
Final Cut Pro.

## Connect Codex

The Codex plugin starts the published Framekit package; it does not install the
Final Cut Workflow Extension. Add the marketplace once:

```sh
codex plugin marketplace add morshoto/framekit
```

Then open `/plugins`, install **Framekit**, and start a new Codex session. The
published MCP server runs through `npx` and needs no repository checkout or
manual `codex mcp add` command. The plugin can also be installed from its
marketplace with `codex plugin add framekit@framekit`. The signed Workflow
Extension is a separate release asset; install it from the matching
[GitHub release](https://github.com/morshoto/framekit/releases) when a live
Final Cut connection is required.

Check connection readiness without starting MCP with:

```sh
npx -y @morshoto/framekit doctor finalcut
```

For more detail, use `connection.status` and `editor.inspect`.
`CAPABILITY_UNAVAILABLE` is an operation-level diagnostic: a ready live session
may expose metadata while rejecting unsupported operations. Inspect the
operation's capability before use.

## Connect Claude Code

Register the published package as a user-scoped stdio server:

```sh
claude mcp add --env FRAMEKIT_EDITOR=final-cut-live \
  --scope user --transport stdio framekit -- \
  npx -y @morshoto/framekit mcp --headless
claude mcp list
claude mcp get framekit
```

Headless mode does not launch, focus, or mutate Final Cut through UI
automation. Accessibility and Automation permissions are required only for an
explicit headed native-write workflow. Start a new client session after
changing its server registration.

For a development extension, build it from the checkout:

```sh
pnpm run xcode:check
bash adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/build.sh
pnpm run framekit -- connect finalcut --development
```

The explicit development connect command may gracefully reload Final Cut so
it loads the selected extension. Native editing remains a separate, explicitly
headed workflow with target binding, preview, readback, and Undo requirements.
See [Architecture](./architecture.md#headless-and-native-editing) before using
native capabilities.

For explicit local native validation, bind both processes to the same checkout
commit and require their build fingerprints to match:

```sh
FRAMEKIT_EDITOR=final-cut-live \
FRAMEKIT_FINAL_CUT_CANONICAL_PROVIDER=native \
FRAMEKIT_FINAL_CUT_NATIVE_WRITES=1 \
FRAMEKIT_FINAL_CUT_HEADLESS=0 \
FRAMEKIT_VALIDATION_COMMIT="$(git rev-parse HEAD)" \
pnpm run framekit -- mcp --editor final-cut-live --development
```

Register that development server as a separate Codex entry when testing a
clean client session:

```sh
codex mcp add framekit-local \
  --env FRAMEKIT_EDITOR=final-cut-live \
  --env FRAMEKIT_FINAL_CUT_CANONICAL_PROVIDER=native \
  --env FRAMEKIT_FINAL_CUT_NATIVE_WRITES=1 \
  --env FRAMEKIT_FINAL_CUT_HEADLESS=0 \
  --env FRAMEKIT_VALIDATION_COMMIT="$(git rev-parse HEAD)" \
  -- pnpm run framekit -- mcp --editor final-cut-live --development
```

Continue only when `preflight.buildAlignment.status` is `matched`. The MCP
process may use `FRAMEKIT_BUILD_COMMIT` for a reproducible external target;
the extension records its checkout commit in its bundle metadata. Accessibility
and Automation permissions are required only for an explicit headed
native-write setup.

For safe validation commands and the distinction between fixture, artifact,
metadata, canonical-live, and headed-native proof, see [Testing](./testing.md).
