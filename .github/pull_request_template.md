## Summary

<!-- What changed, and why? Link the issue or design decision when applicable. -->

## Scope

- [ ] Runtime or domain model
- [ ] MCP server
- [ ] Editor adapter
- [ ] Native Final Cut bridge
- [ ] Tests or fixtures
- [ ] Documentation

## Validation

<!-- List the commands you ran and summarize the result. -->

```text
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
