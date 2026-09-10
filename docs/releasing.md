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

The same trust relationship can be configured from an authenticated npm CLI
session after the package exists on the registry:

```sh
npm trust github @morshoto/framekit \
  --repo morshoto/framekit \
  --file release.yml \
  --allow-publish \
  --yes
```

The package metadata must keep its `repository.url` aligned with the GitHub
repository. The workflow uses GitHub's OIDC identity and does not require an
`NPM_TOKEN` repository secret.

## Release flow

1. Merge the tagpr release pull request into `main`.
2. The `tagpr` job creates the version tag and a draft GitHub release with
   generated notes. If the merge already placed the release tag on `HEAD`,
   the workflow reuses that tag instead of trying to create it again.
3. The `publish-npm` job installs npm 11.5.1, publishes the matching package,
   and verifies the version on the public registry.
4. Only after npm verification succeeds, the workflow publishes the GitHub
   release and its notes.

If npm publishing fails, the GitHub release remains a draft so the failure can
be repaired without presenting an incomplete release as public.

If a retry finds a draft release whose tag is shown as `untagged-*`, the
workflow associates that draft with the release tag before publishing it.

The npm Trusted Publisher relationship is configured in npm account settings;
repository permissions alone cannot create or repair that relationship. The
workflow can only use the OIDC identity after the relationship exists.

## Local validation

Run the standard checks before merging a release pull request:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run test
pnpm run check:boundaries
npm pack --dry-run
pnpm run release-gate --output-dir artifacts/release-gate/local-run
```

For the v0.0.3 release, attach the release gate `report.json` and
`manifest.json` as evidence. The deterministic fixture gate, FCPXML adapter
coverage, opt-in live Final Cut evidence, and unsupported capabilities must be
reported separately. Fixture success does not establish autonomous open-project
Final Cut support; that claim requires the documented disposable headed run.

The release workflow performs the registry and GitHub release steps on GitHub's
hosted runner; OIDC authentication cannot be fully reproduced locally.
