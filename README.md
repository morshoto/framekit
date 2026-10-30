<div align="center">
  <img width="300" height="300" alt="image" src="https://github.com/user-attachments/assets/64248af3-2738-4f60-8155-11d63990624d" />
</div>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white" alt="Node.js 20 or newer" />
  <img src="https://img.shields.io/badge/pnpm-12.14.0-F69220?logo=pnpm&logoColor=white" alt="pnpm 12.14.0" />
  <img src="https://img.shields.io/badge/Final%20Cut%20Pro-macOS-000000?logo=apple&logoColor=white" alt="Final Cut Pro on macOS" />
  <a href="https://discord.gg/Dmp8FSF4vg"><img src="https://img.shields.io/badge/Discord-Join%20Chat-5865F2?logo=discord&logoColor=white" alt="Join the Framekit Discord" /></a>
</p>

# Framekit

Agentic video editing runtime and MCP server for Final Cut Pro.

## Get started

For repository development, you need:

Contributor toolchain: Node.js 22.14.0 and pnpm 12.14.0.
Consumer runtime: Node.js >=20.

Xcode 16.4 and the macOS 15.5 SDK for native Final Cut work.

The Xcode requirement is only needed for the native Workflow Extension. For the
pinned Node and shell toolchain, enter the optional Nix shell first:

```sh
nix develop ./nix
```

From the repository root, install dependencies and run the deterministic checks:

```sh
pnpm install --frozen-lockfile
pnpm run hooks:install
pnpm run check:git-config
pnpm run build
pnpm run test
pnpm run check:boundaries
```

## Try the local MCP server

The local MCP server uses a deterministic in-memory fixture and communicates over
stdio. Start it from the repository root and connect it to an MCP client:

```sh
pnpm run mcp
```

See [Getting started](./docs/getting-started.md) for local and live-backend
setup, and [Architecture](./docs/architecture.md) for capability boundaries.

## Connect Codex to Final Cut

The Codex plugin provides the MCP integration; the Final Cut Workflow Extension
is installed separately. Download a signed extension from a
[Framekit GitHub release](https://github.com/morshoto/framekit/releases) when a
release asset is available, then configure the Framekit marketplace once:

```sh
codex plugin marketplace add morshoto/framekit
```

Open `/plugins` in Codex, find **Framekit**, and select **Install**. Start a new
Codex session to load the Framekit MCP tools. No repository checkout or manual
`codex mcp add` is required.

The plugin runs the published package in headless mode. For live Final Cut
capabilities, it connects only to an existing Workflow Extension bridge and
does not launch, activate, focus, or edit Final Cut through macOS UI automation.
Framekit-owned video projects can register local media, analyze it, create an
approved rough-cut plan, and render a verified MP4 plus editable FCPXML without
a connected Final Cut session. Optional native publishing is experimental and
is not guaranteed in v0.1.18: a document-open dispatch does not prove that
Final Cut completed an import or created a native project. See the
[Codex video production runbook](./plugins/framekit/references/tests/codex-video-production-e2e.md)
and [first-run setup and capability boundaries](./docs/getting-started.md).

For local native development, use the checkout's CLI wrapper from the repository
root:

```sh
pnpm run xcode:check
bash adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/build.sh
pnpm run framekit -- connect finalcut --development
```

## Further Docs

- [Documentation index](./docs/README.md)
- [Getting started](./docs/getting-started.md)
- [Architecture](./docs/architecture.md)
- [Testing](./docs/testing.md)
- [Release](./docs/release.md)

## Development

Contributor setup, repository layout, native checks, and the local pre-commit
hook are documented in [CONTRIBUTING.md](CONTRIBUTING.md).
