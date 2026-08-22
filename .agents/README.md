# Repository agent playbooks

These playbooks describe repository-specific workflows for GitHub issues and
pull requests. They are instructions for an agent using this checkout; they
are not GitHub Actions or autonomous merge automation.

## Playbooks

- [`issue-create.md`](./issue-create.md): draft and create one GitHub issue
  using the repository templates.
- [`issue-read.md`](./issue-read.md): inspect an issue and its linked work
  without mutating GitHub state.
- [`review-pr.md`](./review-pr.md): review a pull request, validate findings,
  apply safe fixes, and record the final review decision.

## Shared rules

- Read [`AGENTS.md`](../AGENTS.md) before changing repository files.
- Use the repository's issue templates and `.github/labels/labels.json` as the
  source of truth for issue metadata.
- Do not invent issue facts, timeline state, test evidence, or editor
  capabilities.
- Never include credentials, private media, user-specific paths, or raw crash
  dumps in issues, comments, or commits.
- Treat live Final Cut capability errors as authoritative and fail closed.
- Do not merge or close pull requests automatically.

## Validation

For repository changes, run the required checks from `AGENTS.md`:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run test
pnpm run check:boundaries
```

When native files change, also run the required Xcode checks.
