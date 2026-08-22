# Framekit Documentation

This directory is the shareable knowledge base for Framekit.

- [PRD](./PRD.md): product goals and roadmap.
- [SDD](./SDD.md): architecture and design contracts.
- [Compatibility](./COMPATIBILITY.md): verified editor and toolchain support.
- [MCP](./mcp/README.md): agent-facing protocol and tools.
- [Tests](./tests/README.md): reproducible checks and evidence.
- [Final Cut](./final-cut/README.md): native integration and operations.
- [Basic Final Cut Editing MVP](./final-cut/basic-editing-mvp.md): issue #7
  workflow, MCP contract, validation gates, and success metrics.
- [Architecture](./architecture/runtime-boundaries.md): runtime boundaries.
- [ADRs](./adr/): durable implementation decisions.

## Documentation rules

Operational documents should state status, last verification date, environment,
scope, expected result, actual evidence, and limitations.

The PRD and SDD remain the high-level sources of truth. Test reports record
what was demonstrated; they do not silently redefine product scope. Sanitize
local evidence before sharing: never commit credentials, private media,
user-specific secrets, or raw crash dumps.
