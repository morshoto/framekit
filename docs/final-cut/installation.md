# Final Cut Pro Installation

## Toolchain

Use the repository's Nix shell for Node and shell tooling:

```sh
nix develop ./nix
```

Xcode remains a host dependency. Confirm the selected version:

```sh
npm run xcode:check
```

The verified native baseline is Xcode 16.4 / build 16F6 with macOS SDK 15.5.

## End-user setup

Register the local MCP server with Codex:

```sh
codex mcp add framekit -- framekit mcp --editor final-cut-live
```

When the MCP process starts, Framekit automatically detects Final Cut Pro,
installs the signed Workflow Extension into the user's Applications directory,
launches it, activates the Framekit extension, and waits for the local socket.
No manual `ditto` or Window → Extensions step is required for a release build.

Check the connection without starting MCP:

```sh
framekit doctor finalcut
```

The default install is per-user and does not require administrator privileges.
macOS may still ask once for permission to let Framekit activate Final Cut Pro.

## Development build

```sh
bash adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/build.sh
```

Build and connect the generated development app through Framekit:

```sh
framekit connect finalcut --development
```

For a prebuilt or locally supplied artifact, set
`FRAMEKIT_EXTENSION_APP_PATH` to the `.app` bundle before running the command.
See the [live E2E test](../tests/final-cut-live-e2e.md) for the complete
read-only procedure.
