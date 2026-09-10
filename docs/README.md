# Framekit Documentation

This directory is the shareable knowledge base for Framekit.

It is also Framekit's deep wiki: a place where users, integrators,
contributors, and curious readers can understand what the project does, how it
is built, and what has actually been validated.

## Start here

Choose the path that matches your question:

- [Getting started](./getting-started/README.md) if you are new to Framekit.
- [Guides](./guides/README.md) if you want to complete a task.
- [Concepts](./concepts/README.md) if you want the ideas and product model.
- [Integrations](./integrations/README.md) if you are connecting an editor or
  an agent.
- [Reference](./reference/README.md) if you need exact tools, protocols, or
  compatibility details.
- [Architecture](./architecture/README.md) if you want to understand the
  implementation boundaries.
- [Project](./project/README.md) for requirements, design documents, and ADRs.
- [Validation](./validation/README.md) for evidence, test scope, and known
  limitations.

These index pages organize the knowledge base without replacing the existing
documents. Content migration is incremental, and the established document
paths remain available while links and readers move to the new structure.

Repository-local GitHub agent playbooks are documented in
[`../.agents/README.md`](../.agents/README.md).

- [Getting started](./getting-started.md): development setup, MCP, and Final Cut connection.
- [Releasing](./releasing.md): npm Trusted Publishing and automated GitHub releases.
- [CodeQL workflow operations](./ci/codeql.md): concurrency and analysis verification.
- [PRD](./PRD.md): product goals and roadmap.
- [Test matrix](./tests/test-matrix.md): delivery scope and evidence by backend.
- [SDD](./SDD.md): architecture and design contracts.
- [Compatibility](./COMPATIBILITY.md): verified editor and toolchain support.
- [MCP](./mcp/README.md): agent-facing protocol and tools.
- [Local speech analysis](./speech-analysis.md): the executable wrapper,
  JSON contract, provenance, and capability boundaries.
- [Rough-cut duration policy](./rough-cut/duration-policy.md): explicit duration tradeoffs and safety defaults.
- [Tests](./tests/README.md): reproducible checks and evidence, including the [golden workflow corpus](./tests/golden-corpus.md), [deterministic MCP evaluation](./tests/mcp-evaluation.md), and [v0.0.3 release gate](./tests/release-gate.md).
- [Generic MCP Skills](./mcp/skills.md): versioned Skill discovery and execution.
- [Skill authoring](./mcp/skill-authoring.md): public manifests, handlers, plans, and lifecycle boundaries.
- [v0.0.2 Skill conformance](./tests/skill-conformance.md): deterministic gate and adapter evidence.
- [v0.0.2 release checklist](./release-v0.0.2-checklist.md): scope and required repository gates.
- [v0.0.3 release evidence](./release-notes-v0.0.3.md): verified behavior and explicit unsupported boundaries.
- [Final Cut](./final-cut/README.md): native integration and operations.
- [Native media insertion breakthrough](./final-cut/native-media-insertion-breakthrough.md):
  verified Browser discovery, focus recovery, modal handling, and live proof.
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
