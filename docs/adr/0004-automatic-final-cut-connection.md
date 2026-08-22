# ADR-0004: Automatic Final Cut Connection Lifecycle

- Status: Accepted
- Date: 2026-08-16

## Context

The Workflow Extension is required to access live Final Cut state, but manual
build, installation, extension activation, and socket troubleshooting create a
poor MCP onboarding experience.

## Decision

Framekit owns the local connection lifecycle through a TypeScript supervisor.
The supervisor detects or launches Final Cut Pro, installs a per-user signed
Workflow Extension artifact, activates the extension, polls the versioned Unix
socket with bounded timeouts, and retries after disconnection.

The MCP server exposes `connection.status` while setup is in progress. Live
editor tools remain fail-closed and never downgrade to fixture data. The native
extension remains the only component that loads Final Cut's host framework.

Codex uses the standard local STDIO MCP registration:

```sh
codex mcp add framekit -- framekit mcp --editor final-cut-live
```

## Consequences

- Users do not manually copy or activate the extension in the normal release flow.
- A one-time macOS Automation permission may still be required.
- Release artifacts must be signed, notarized, and checksum-verified.
- Development builds retain the existing ad-hoc Xcode path.
- The first automatic connection milestone remains read-only.
