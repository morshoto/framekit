<!-- Title naming policy -->
<!-- Use a concise conventional prefix when useful: `feat:`, `fix:`, `perf:`,
     `refactor:`, `docs:`, `test:`, `design:`, or `chore:`. -->

- [ ] Request PR review
- [ ] If you are unable to review, please set it as a [PR draft](https://github.blog/2019-02-14-introducing-draft-pull-requests/) draft.
- [ ] Github issue: Closes: #

## Summary

<!-- Please provide a summary of what you did in this pull request -->
<!-- Example: Added △△ functionality to resolve the issue with 〇〇 -->
<!-- Please attach a Github Label to indicate the type of PR -->
<!-- open -->

<!-- close -->

## Validation

<!-- List the commands you ran and summarize the result. -->

```bash
pnpm run build
pnpm run test
pnpm run check:boundaries
```

Native changes should also include the relevant macOS/Xcode validation.

## Architecture and compatibility

- [ ] Runtime remains independent of MCP and editor-specific implementations.
- [ ] Supported public MCP behavior is documented when changed.
- [ ] Existing adapters and test fixtures remain compatible, or the migration is explained above.

<!-- When documentation files change, replace this comment with:
Documentation intent: intentional
Documentation paths:
- path/to/changed-document.md
Documentation purpose: Explain why the documentation change is needed.
Documentation minimality: Explain why these are the smallest necessary edits.
List every changed documentation path. Use docs/** only for the one-time migration linked to issue #572.
When no documentation files change, no declaration is needed. -->

## Safety

- [ ] No credentials, private media, raw crash dumps, or user-specific local paths were added.
- [ ] Generated files and build artifacts are excluded.
- [ ] Docs: not needed (state why), or changed docs have a matching declaration with paths, purpose, and minimal scope.
