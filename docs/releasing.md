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
3. Hosted jobs validate package/plugin alignment and, for milestone releases,
   generate the milestone report.
4. The `publish-npm` job installs npm 11.5.1, runs the repository release gate,
   publishes the matching package, verifies the version on the public registry,
   and publishes the GitHub release.
5. Native Final Cut assets are deliberately outside this publication critical
   path. Run the separate `Native release assets` workflow for the published
   tag when a trusted Final Cut-capable Mac is available.
6. The native workflow builds and signs
   `FramekitFinalCutWorkflow-<version>.zip`, uploads it with its checksum to the
   existing GitHub release, and then runs `verify-release-provenance`.

The automatic npm/GitHub release therefore does not block on a self-hosted
macOS runner. A missing or offline native runner can delay the Final Cut binary,
but it cannot leave package publication waiting in the release workflow.

## Native release assets

The `Native release assets` workflow is an explicit follow-up operation. Run it
from GitHub Actions with the exact published tag in the `release_tag` input, or
from the CLI:

```sh
gh workflow run native-release.yml \
  --repo morshoto/framekit \
  --ref main \
  -f release_tag=v0.1.10
```

The workflow first validates on a GitHub-hosted runner that the requested tag
exists, is reachable from `main`, and has a GitHub release. Only then does the
packaging job target the trusted self-hosted macOS runner carrying the
`framekit-release` label.

That runner must have Final Cut Pro installed, Xcode command-line tools, and a
Developer ID signing identity available to `codesign`. Configure the
`FRAMEKIT_CODESIGN_IDENTITY` secret and the optional
`FRAMEKIT_NOTARY_PROFILE` repository variable. The runner must expose all three
labels: `self-hosted`, `macOS`, and `framekit-release`.

There is intentionally no runner-enumeration preflight. If this dedicated
workflow is queued because the Mac is offline, start or restore the runner and
retry the native workflow. This queue does not block npm publication or the
GitHub release.

After packaging, the workflow uploads
`FramekitFinalCutWorkflow-<version>.zip` and
`FramekitFinalCutWorkflow-<version>.zip.sha256` with `--clobber`, so rerunning
an exact tag safely replaces a partial or stale native upload. It then runs:

```sh
pnpm run verify-release-provenance
```

That post-upload check verifies package, MCP server, plugin, tag, workflow,
GitHub release, npm, native archive, and checksum alignment.

## Retrying npm/GitHub publication

If npm publishing fails, repair the npm Trusted Publisher relationship or the
underlying release problem and retry the exact existing tag without creating a
new version:

```sh
gh workflow run release.yml \
  --repo morshoto/framekit \
  --ref main \
  -f release_tag=v0.1.10
```

The manual run verifies that the tag exists and points to a commit reachable
from `main`, checks out that exact tag, and skips `npm publish` if the matching
version is already present. After a publish, registry visibility is retried
with bounded backoff. If a retry races with an earlier successful publish and
npm reports that the version already exists, the workflow proceeds to that
same verification path. Registry errors other than a missing version or an
immutable-version conflict fail closed.

If a retry finds a draft release whose tag is shown as `untagged-*`, the
workflow associates that draft with the release tag before publishing it.

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
```

After the native assets exist on a published release, the authenticated
provenance check can also be run locally:

```sh
RELEASE_TAG=v0.1.10 GITHUB_REPOSITORY=morshoto/framekit \
  pnpm run verify-release-provenance
```

For the v0.1.6 release gate, attach `report.json` and `manifest.json` as
evidence. The deterministic, FCPXML artifact, metadata-only, canonical-live,
and opt-in headed-native tiers must be reported separately. Fixture success
does not establish autonomous open-project Final Cut support; that claim
requires the documented disposable headed run.

The release workflow performs the registry and GitHub release steps on GitHub's
hosted runner; OIDC authentication cannot be fully reproduced locally. Native
binary production and the complete post-upload provenance verification remain
separate because they require the Final Cut-capable macOS environment.
