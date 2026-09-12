# Releasing Framekit

Framekit releases are created from `main` by the tagpr workflow in
`.github/workflows/release.yml`.

## One-time npm setup

Configure npm Trusted Publishing for `@morshoto/framekit` with these values:

- Provider: GitHub Actions
- Organization or user: `morshoto`
- Repository: `framekit`
- Workflow filename: `release.yml`
- Allowed action: direct `npm publish` (not only `npm stage publish`)

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
3. The `native-release-assets` job runs on the configured `framekit-release`
   macOS runner, builds and signs the Final Cut Workflow Extension, and uploads
   `FramekitFinalCutWorkflow-<version>.zip` plus its checksum to the draft
   release.
4. The `publish-npm` job installs npm 11.5.1, runs the v0.1.6 repository gate,
   publishes the matching package, and verifies the version on the public
   registry. It waits for the native assets to be uploaded.
5. The workflow verifies the native archive and checksum, then publishes the
   GitHub release and its notes.
6. A final provenance gate verifies package, MCP server, plugin, tag, workflow,
   GitHub release, npm, native archive, and checksum alignment before the
   workflow can succeed.

The `framekit-release` runner must be a trusted macOS runner with Final Cut Pro
installed, Xcode command-line tools, and a Developer ID signing identity
available to `codesign`. Configure the `FRAMEKIT_CODESIGN_IDENTITY` secret and
the optional `FRAMEKIT_NOTARY_PROFILE` repository variable before merging a
release PR. The runner must be registered with the `framekit-release` label.

If npm publishing fails, the GitHub release remains a draft so the failure can
be repaired without presenting an incomplete release as public.

If a retry finds a draft release whose tag is shown as `untagged-*`, the
workflow associates that draft with the release tag before publishing it.

After repairing the npm Trusted Publisher relationship, retry an existing tag
without creating a new commit or version:

```sh
gh workflow run release.yml \
  --repo morshoto/framekit \
  --ref main \
  -f release_tag=v0.1.3
```

The manual run verifies that the tag exists and points to a commit reachable
from `main`, checks out that exact tag, and skips `npm publish` if the matching
version is already present. After a publish, registry visibility is retried
with bounded backoff. If a retry races with an earlier successful publish and
npm reports that the version already exists, the workflow proceeds to that
same verification path. The native release job also rebuilds and uploads the
assets before verification. Registry errors other than a missing version or an
immutable-version conflict fail closed.

The npm Trusted Publisher relationship is configured in npm account settings;
repository permissions alone cannot create or repair that relationship. The
workflow can only use the OIDC identity after the relationship exists.

## Milestone status reports

Patch releases keep the normal lightweight release flow. For a milestone tag
such as `v0.2.0`, the workflow compares it with the previous patch-zero tag,
runs the reproducible c8 test-coverage command for both revisions, reads the
matching GitHub milestone and public activity, and uploads these assets to the
draft release:

```text
artifacts/release-report/
  report.json
  report.md
  charts/coverage.svg
  charts/roadmap-progress.svg
  charts/contributors.svg
```

The same report can be regenerated locally from explicit coverage summaries and
an optional saved GitHub snapshot:

```sh
C8_REPORTS_DIR=artifacts/release-report/current-coverage pnpm run test:coverage
pnpm run release-report -- \
  --baseline-tag v0.1.0 \
  --current-tag v0.2.0 \
  --baseline-coverage artifacts/release-report/baseline-coverage/coverage-summary.json \
  --current-coverage artifacts/release-report/current-coverage/coverage-summary.json \
  --data-file github-release-data.json \
  --output-dir artifacts/release-report
```

Without `--data-file`, the generator uses `gh api` for the public GitHub
milestone, merged pull requests, and closed issues in the exact tag window.
The roadmap percentage is based on the GitHub milestone's closed and open issue
counts; contributor totals exclude accounts marked as bots or ending in
`[bot]`. The report has no generated timestamp, so identical inputs produce
identical JSON, Markdown, and SVG output.

## Local validation

Run the standard checks before merging a release pull request:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run build:package
node scripts/validate-mcp-server-version.mjs
pnpm run test
pnpm run check:boundaries
npm pack --dry-run
pnpm run release-gate --output-dir artifacts/release-gate/local-run
RELEASE_TAG=v0.1.6 GITHUB_REPOSITORY=morshoto/framekit \
  pnpm run verify-release-provenance
```

For the v0.1.6 release, attach the release gate `report.json` and
`manifest.json` as evidence. The deterministic, FCPXML artifact,
metadata-only, canonical-live, and opt-in headed-native tiers must be reported
separately. Fixture success does not establish autonomous open-project Final
Cut support; that claim requires the documented disposable headed run.

The native release assets must be named
`FramekitFinalCutWorkflow-<version>.zip` and
`FramekitFinalCutWorkflow-<version>.zip.sha256`. The checksum must match the
archive before the GitHub release is made public. Missing assets or a malformed
checksum keep release completion blocked.

The release workflow performs the registry and GitHub release steps on GitHub's
hosted runner; OIDC authentication cannot be fully reproduced locally. The
final provenance command is therefore an authenticated post-publication check.
