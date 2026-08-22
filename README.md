<div align="center">
  <img width="300" height="300" alt="image" src="https://github.com/user-attachments/assets/64248af3-2738-4f60-8155-11d63990624d" />
</div>

<p align="center">
  <img src="https://img.shields.io/badge/Swift-5.9%2B-F05138?logo=swift&logoColor=white" alt="Swift 5.9 or newer" />
  <img src="https://img.shields.io/badge/Python-3.13-3776AB?logo=python&logoColor=white" alt="Python 3.13" />
  <img src="https://img.shields.io/badge/platform-Apple%20Silicon%20macOS-000000?logo=apple&logoColor=white" alt="Apple Silicon macOS" />
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

Register the local MCP server with Codex:

```sh
codex mcp add framekit -- framekit mcp --editor final-cut-live --headless
```

## Further Docs

- [Documentation index](./docs/README.md)
- [Architecture](./docs/ARCHITECTURE.md)

## Development

Contributor setup, including the local pre-commit hook, is documented in [`CONTRIBUTOR.md`](CONTRIBUTOR.md).
