# Releasing Framekit

Framekit releases are created from `main` by the tagpr workflow in
`.github/workflows/release.yml`.

## One-time npm setup

Configure npm Trusted Publishing for `@morshoto/framekit` with these values:

- Provider: GitHub Actions
- Organization or user: `morshoto`
- Repository: `framekit`
- Workflow filename: `release.yml`
- Allowed action: `npm publish`

The package metadata must keep its `repository.url` aligned with the GitHub
repository. The workflow uses GitHub's OIDC identity and does not require an
`NPM_TOKEN` repository secret.

## Release flow

1. Merge the tagpr release pull request into `main`.
2. The `tagpr` job creates the version tag and a draft GitHub release with
   generated notes.
3. The `publish-npm` job installs npm 11.5.1, publishes the matching package,
   and verifies the version on the public registry.
4. Only after npm verification succeeds, the workflow publishes the GitHub
   release and its notes.

If npm publishing fails, the GitHub release remains a draft so the failure can
be repaired without presenting an incomplete release as public.

## Local validation

Run the standard checks before merging a release pull request:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run test
pnpm run check:boundaries
npm pack --dry-run
```

The release workflow performs the registry and GitHub release steps on GitHub's
hosted runner; OIDC authentication cannot be fully reproduced locally.
