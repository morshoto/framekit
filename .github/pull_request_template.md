<!-- Title naming policy -->
<!-- `feat:`, `fix:`, `perf:`, `design:`, `chore:` -->

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
- [ ] Public MCP behavior or package interfaces are documented if changed.
- [ ] Existing adapters and test fixtures remain compatible, or the migration is explained above.

## Safety

- [ ] No credentials, private media, raw crash dumps, or user-specific local paths were added.
- [ ] Generated files and build artifacts are excluded.
- [ ] Documentation reflects any changed commands, paths, or environment variables.
