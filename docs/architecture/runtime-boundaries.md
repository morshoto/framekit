# Runtime Boundaries

The runtime is split into editor-independent TypeScript and editor-specific
Swift integration:

```text
Agent → MCP stdio → TypeScript runtime → adapter → local IPC → Swift extension → Final Cut Pro
```

TypeScript owns the domain model, MCP adapter, context, transactions, diffs,
verification, and capability decisions. Swift owns Final Cut-hosted state
observation and the native Workflow Extension API.

The runtime must not leak Final Cut-specific types into the common agent
contract. The backend reports capabilities so the agent can choose a safe
operation or receive an explicit failure.
