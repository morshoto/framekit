# ADR-0001: Use a Final Cut Workflow Extension with Local IPC

- Status: Accepted
- Date: 2026-08-16

## Context

The runtime needs live Final Cut state, but the Node MCP process must not load
Final Cut's native host framework directly. The integration also needs to stay
local because projects may contain private media.

## Decision

Build a Swift Final Cut Workflow Extension hosted by Final Cut Pro and connect
it to the TypeScript runtime through a Unix-domain socket using newline-
delimited JSON.

## Consequences

- Native API access stays inside the host extension.
- The MCP runtime remains editor-agnostic and testable without Final Cut.
- The local socket is simple to inspect and bounded by timeouts.
- Installation and host registration are macOS-specific.
- The protocol must remain versioned and fail closed on incompatibility.
