# Release and provenance

The release workflow starts from `main` and coordinates a tagpr release pull
request, npm publication, the GitHub release, release-note formatting, and
native extension packaging. Package publication does not imply that a signed
Final Cut Workflow Extension is available.

## npm trusted publishing

Configure npm Trusted Publishing for `@morshoto/framekit` with provider
GitHub Actions, repository `morshoto/framekit`, workflow `release.yml`, and
direct `npm publish` permission. The workflow uses GitHub's OIDC identity and
does not require an `NPM_TOKEN` repository secret. Keep the package's
`repository.url` aligned with the GitHub repository. An optional
`NPM_LIFECYCLE_TOKEN` enables npm lifecycle-status checks; registry
verification remains the fallback when that endpoint or token is unavailable.
An npm `validating` response stays pending while the workflow waits up to 16 minutes
for public registry verification.

The equivalent one-time npm CLI configuration is:

```sh
npm trust github @morshoto/framekit \
  --repo morshoto/framekit \
  --file release.yml \
  --allow-publish \
  --yes
```

## Release flow

1. Merge the tagpr release pull request into `main`.
2. The release workflow creates or reuses the exact version tag and draft
   release, then checks package, plugin, and server alignment.
3. Hosted validation runs the release gate and publishes the package through
   npm Trusted Publishing. It verifies the public registry version and a
   clean client installation before publishing the GitHub release.
4. Publishing the GitHub release starts native packaging in the same workflow.
   Native signing and verification run separately on the trusted Final Cut-capable
   macOS runner and do not block npm publication.
5. Download the uploaded extension archive and checksum, verify the archive,
   signature, version, and source commit, then run
   `pnpm run verify-release-provenance`.

The native packaging job requires the dedicated self-hosted Mac, Xcode
command-line tools, Final Cut Pro, and a Developer ID signing identity. Missing
native assets leave native provenance unverified; they do not delay npm
publication. The signature, checksum, package, plugin, MCP server, and extension
identities must match the exact tag before claiming release readiness.

## Native release assets

The `release.published` event starts native validation and packaging. When the
release workflow publishes a release with `GITHUB_TOKEN`, it also sends a
`repository_dispatch` event because token-created release events do not start a
new workflow run. Both paths validate that the exact tag is reachable from
`main` and has a GitHub release before packaging and signing on the self-hosted
macOS runner labelled `self-hosted`, `macOS`, and `framekit-release`. Configure
the `FRAMEKIT_CODESIGN_IDENTITY` secret and, when notarization is used, the
`FRAMEKIT_NOTARY_PROFILE` variable. A missing or offline runner does not block
npm publication or the GitHub release.

To retry a failed native job, rerun the failed job from its `release.yml` run.

After upload, verify `FramekitFinalCutWorkflow-<version>.zip` and its
`.sha256` file from the release. The workflow also downloads and verifies the
uploaded assets, app signature, extension version, and source commit before
`pnpm run verify-release-provenance` reports an overall `GO` or `NO_GO`.

## Validation and retries

Before a release pull request is merged, run the standard checks in
[Testing](./testing.md), then validate package and release metadata:

```sh
pnpm run build:package
node scripts/validate-mcp-server-version.mjs
npm pack --dry-run
pnpm run release-gate --output-dir artifacts/release-gate/local-run
```

The release workflow runs `node scripts/validate-mcp-server-version.mjs`
after building the package and before `npm publish`.

The hosted workflow owns OIDC publication and public registry verification;
these local commands do not prove a published release. If a publish fails,
repair the Trusted Publisher relationship or release issue, then retry the
same existing tag with the release workflow's `release_tag` input. Do not
create a new version to recover a partial upload.

Keep sanitized report manifests, package checksums, signed native archives,
and their verification output on the relevant GitHub release or workflow run.
Preserve the tested tag, source commit, artifact digest, verification status,
and any remaining blocker with the evidence. Never present fixture success,
artifact dispatch, or metadata observation as a completed native import.

Milestone reports are generated from explicit baseline/current coverage,
GitHub milestone activity, and the corresponding tags. Store their JSON,
Markdown, and chart assets with the draft release. Exact reruns from the same
inputs should remain reproducible.
