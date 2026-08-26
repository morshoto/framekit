# Framekit Documentation

This directory is the shareable knowledge base for Framekit.

Repository-local GitHub agent playbooks are documented in
[`../.agents/README.md`](../.agents/README.md).

- [Getting started](./getting-started.md): development setup, MCP, and Final Cut connection.
- [PRD](./PRD.md): product goals and roadmap.
- [SDD](./SDD.md): architecture and design contracts.
- [Compatibility](./COMPATIBILITY.md): verified editor and toolchain support.
- [MCP](./mcp/README.md): agent-facing protocol and tools.
- [Tests](./tests/README.md): reproducible checks and evidence, including the [golden workflow corpus](./tests/golden-corpus.md) and [deterministic MCP evaluation](./tests/mcp-evaluation.md).
- [Final Cut](./final-cut/README.md): native integration and operations.
- [Basic Final Cut Editing MVP](./final-cut/basic-editing-mvp.md): issue #7
  workflow, MCP contract, validation gates, and success metrics.
- [Architecture overview](./ARCHITECTURE.md): runtime, MCP, and adapter boundaries.
- [Architecture](./architecture/runtime-boundaries.md): runtime boundaries.
- [ADRs](./adr/): durable implementation decisions.

## Documentation rules

Operational documents should state status, last verification date, environment,
scope, expected result, actual evidence, and limitations.

The PRD and SDD remain the high-level sources of truth. Test reports record
what was demonstrated; they do not silently redefine product scope. Sanitize
local evidence before sharing: never commit credentials, private media,
user-specific secrets, or raw crash dumps.
