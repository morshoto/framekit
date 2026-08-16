# Framekit Contribution Instructions

## Repository shape

- `packages/runtime` contains editor-independent domain types, context, diff,
  editing, and verification logic.
- `apps/mcp-server` contains the MCP transport and tool definitions only.
- `adapters/final-cut/typescript` contains the Node-side Final Cut adapters.
- `adapters/final-cut/swift-bridge` contains the macOS Workflow Extension.
- `packages/testkit` contains deterministic in-memory editors and analyzer
  fixtures.

Keep dependencies flowing toward the runtime contracts. The runtime must not
import MCP SDK modules or Final Cut adapter modules.

## Required validation

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run test
pnpm run check:boundaries
```

For native changes, also run:

```sh
pnpm run xcode:check
xcodebuild -project adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/FramekitFinalCutWorkflow.xcodeproj -list
```

## Change boundaries

- Preserve the MCP tool contract unless the change explicitly updates its
  documentation and tests.
- Keep `playheadTime` and related timeline terminology when referring to the
  editor concept; use `Framekit` for product branding.
- Use `FRAMEKIT_EDITOR`, `FRAMEKIT_FCPXML_PATH`, and
  `FRAMEKIT_FINAL_CUT_SOCKET` for runtime configuration.
- Update documentation when moving files, changing commands, or changing
  environment variables.
- Do not commit `node_modules`, `dist`, credentials, private media, raw crash
  dumps, or user-specific local paths.

## Testing guidance

Prefer deterministic fixtures for runtime and MCP tests. Native Final Cut
validation is a separate macOS concern; do not weaken the runtime contract or
invent timeline data when the native bridge reports a capability as
unavailable.
