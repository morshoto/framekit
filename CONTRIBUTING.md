# Contributing to Framekit

For first-time setup, including installation of the local pre-commit hook, see
[`CONTRIBUTOR.md`](CONTRIBUTOR.md).

## Development setup

Requirements:

- Node.js 20 or newer (CI runs Node.js 22);
- pnpm 11.10.0;
- Xcode 16.4 and the macOS 15.5 SDK for native work.

Install dependencies and run the standard checks:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run test
pnpm run check:boundaries
```

The deterministic MCP fixture is available with:

```sh
pnpm run mcp
```

## Where changes belong

- Put editor-independent behavior in `packages/runtime`.
- Put MCP schemas, tool registration, and stdio transport in
  `apps/mcp-server`.
- Put Final Cut document/live/session behavior in
  `adapters/final-cut/typescript`.
- Put Workflow Extension and Xcode changes in
  `adapters/final-cut/swift-bridge`.
- Put deterministic adapters and analyzer fixtures in `packages/testkit`.

Do not make the runtime depend on MCP SDK or editor-specific adapter code.

## Native Final Cut work

Validate the toolchain first:

```sh
pnpm run xcode:check
```

Build the Workflow Extension with:

```sh
bash adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/build.sh
```

The native bridge is intentionally fail-closed when Final Cut does not expose
complete timeline or media enumeration.

## What the hook checks

Every commit runs:

```sh
pnpm run build
pnpm run test
pnpm run check:boundaries
```

When staged files include the Swift Workflow Extension, Xcode project, or
native toolchain configuration, macOS contributors also run:

```sh
pnpm run xcode:check
xcodebuild -project adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/FramekitFinalCutWorkflow.xcodeproj -list
```

The hook does not run headed Final Cut Pro tests. Those require a local Final
Cut installation, an active library, Accessibility permissions, and private
media/project state. On non-macOS systems, native checks are reported as a CI
requirement instead of blocking the commit.

The hook also forces `FRAMEKIT_EDITOR=fixture`,
`FRAMEKIT_COMMIT_VALIDATION=1`,
`FRAMEKIT_FINAL_CUT_HEADLESS=1`, `FRAMEKIT_FINAL_CUT_NATIVE_WRITES=0`, and
`FRAMEKIT_AUTO_CONNECT=0` while running validation. This prevents inherited
shell configuration from launching or activating Final Cut Pro during a
commit.


## Pull requests

Every pull request should explain the behavior or structure being changed,
include the commands used for validation, and call out MCP, package, or native
compatibility impact. Keep unrelated refactors out of feature changes.

Do not include credentials, private media, raw crash dumps, or machine-specific
paths in commits, tests, logs, or documentation.
