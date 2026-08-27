<div align="center">
  <img width="300" height="300" alt="image" src="https://github.com/user-attachments/assets/64248af3-2738-4f60-8155-11d63990624d" />
</div>

<p align="center">
  <img src="https://img.shields.io/badge/Swift-5.9%2B-F05138?logo=swift&logoColor=white" alt="Swift 5.9 or newer" />
  <img src="https://img.shields.io/badge/Python-3.13-3776AB?logo=python&logoColor=white" alt="Python 3.13" />
  <img src="https://img.shields.io/badge/platform-Apple%20Silicon%20macOS-000000?logo=apple&logoColor=white" alt="Apple Silicon macOS" />
  <a href="https://discord.gg/Dmp8FSF4vg"><img src="https://img.shields.io/badge/Discord-Join%20Chat-5865F2?logo=discord&logoColor=white" alt="Join the Framekit Discord" /></a>
</p>

# Framekit

Agentic video editing runtime. 

## Installation

Requirements:

```sh
pnpm install --frozen-lockfile
pnpm run hooks:install
pnpm run test
pnpm run build
```

## Quick Start

The reproducible Node shell and native toolchain contract live under [`nix/`](nix/). Enter it with `nix develop ./nix`, then run `pnpm run xcode:check` before building the Final Cut Workflow Extension.

## MCP server

The local MCP server uses the deterministic in-memory Phase 2 fixture:

```sh
pnpm run mcp
```

The default `.env.example` starts the Diffusers visual service without the optional music stack. `Cmd-D` toggles Developer Mode and `Cmd-F` toggles the borderless exhibition presentation.

## Connect Codex to Final Cut

Install the signed Framekit Workflow Extension from the latest release, then
configure the Framekit marketplace once:

```sh
codex plugin marketplace add morshoto/framekit
```

Open `/plugins` in Codex, find **Framekit**, and select **Install**. Start a new
Codex session to load the Framekit MCP tools. No repository checkout or manual
`codex mcp add` is required.

The plugin runs the published package in headless mode. It connects only to an
existing Workflow Extension bridge and does not launch, activate, focus, or
edit Final Cut through macOS UI automation. See the
[first-run setup and capability boundaries](./docs/final-cut/installation.md).

## Further Docs

- [Documentation index](./docs/README.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [Clean Codex and Claude Code MCP validation](./docs/tests/clean-mcp-clients.md)

## Development

Contributor setup, including the local pre-commit hook, is documented in [`CONTRIBUTOR.md`](CONTRIBUTOR.md).
