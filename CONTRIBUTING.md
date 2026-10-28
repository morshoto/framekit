# Contributing to Framekit

For first-time setup, install the local pre-commit hook with
`pnpm run hooks:install` after installing dependencies.

When linked worktrees are in use, `hooks:install` also enables Git's
worktree-local configuration and protects the current worktree with
`core.bare=false` and `core.hooksPath=.githooks`. Check the repository state with:

```sh
pnpm run check:git-config
```

If the check reports shared Git corruption, run `pnpm run hooks:install`. If Git
cannot enter the checkout, use the explicit `git config --file` repair commands
printed by the guard before retrying.

## Development setup

Requirements:

- Node.js 20 or newer (CI runs Node.js 22);
- pnpm 12.3.4;
- Xcode 16.4 and the macOS 15.5 SDK for native work.

Install dependencies and run the standard checks:

```sh
pnpm install --frozen-lockfile
pnpm run hooks:install
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

## Documentation changes

Update documentation only when a change affects user-facing setup or commands,
supported public MCP contracts or behavior, production architecture invariants
or capability boundaries, or the release process. Internal refactors, test
additions, and bug fixes with unchanged external behavior do not need a docs
edit. If no tracked documentation file changes, no declaration is required in
the pull request.

When documentation is needed, update only the canonical document that owns the
information and the smallest relevant section. Avoid unrelated rewrites, broad
formatting, duplicate explanations, new ADRs, and one-off feature documents.
Put implementation rationale in the issue, pull request, review discussion,
and tests. Keep durable QA and release evidence linked from issues, pull
requests, workflow artifacts, or releases so its source and status remain
auditable. Keep TDD plans, detailed QA transcripts, run logs, generated tool
catalogs, and ephemeral evidence out of tracked docs; retain them in tests,
workflow artifacts, issues, pull requests, or releases according to their
audit needs. Preserve required user-facing, safety, compatibility, legal,
security, and release provenance information.

For the one-time documentation consolidation, follow the five-file target and
evidence-retention requirements in issue #572.

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
node scripts/check-git-config.mjs
node scripts/check-staged-content.mjs
pnpm run build
pnpm run test
pnpm run check:boundaries
```

The staged-content step inspects the staged commit payload, including staged filenames
and added text, and fails closed for credentials, user-specific paths, private
media files, diagnostic dump files, and binary content. It reports only the
affected repository path, line, and category; matched values are never printed.
Sanitize or remove the affected content from the index, then stage the safe
replacement before retrying the commit.

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

When attached to an interactive terminal, the hook displays colored stages and
an animated spinner while each check runs. Set `NO_COLOR=1` to disable both
colors and animation.


## Pull requests

Every pull request should explain the behavior or structure being changed,
include the commands used for validation, and call out MCP, package, or native
compatibility impact. Keep unrelated refactors out of feature changes.

Do not include credentials, private media, raw crash dumps, or machine-specific
paths in commits, tests, logs, or documentation.
