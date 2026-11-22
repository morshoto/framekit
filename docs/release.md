# Release and provenance

Release notes place the description of the milestone titled `Release for
vX.Y.Z` before the changelog. If no unique milestone with a nonempty
description exists, automation warns and retains the changelog without a
description.

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
   release, then checks package, plugin, and server alignment. Swift CodeQL
   scans the tagged commit and blocks publication for open error or
   high-or-higher security alerts.
3. Hosted validation runs the release gate and publishes the package through
   npm Trusted Publishing. It verifies the public registry version and a
   clean client installation before publishing the GitHub release.
4. Publishing the GitHub release starts a native packaging run from
   `release.yml`. Native signing and verification run separately on the trusted
   Final Cut-capable macOS runner and do not block npm publication.
5. Download the uploaded extension archive and checksum, verify the archive,
   signature, version, and source commit, then run
   `pnpm run verify-release-provenance`.

The native packaging job requires the dedicated self-hosted Mac, Xcode
command-line tools, Final Cut Pro, and a Developer ID signing identity. Missing
native assets leave native provenance unverified; they do not delay npm
publication. For artifact-first readiness, the package, plugin and MCP server
identities, clean-install evidence, and artifact workflow results must match
the exact release candidate. Native distribution additionally requires the
extension signature, checksum, version and source identity to match the tag;
native observation and mutation require their own authorized acceptance
evidence. Record each readiness verdict separately.

## Native release assets

The `release.published` event starts native validation and packaging. When the
release workflow publishes a release with `GITHUB_TOKEN`, it also sends a
`repository_dispatch` event because token-created release events do not start a
new workflow run. Both paths validate that the exact tag is reachable from
`main`, has a GitHub release, and has passing Swift CodeQL evidence for the
tagged commit before packaging and signing on the self-hosted
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

For the MCP TypeScript SDK v2 migration, include the SDK change and any verified
client compatibility differences in the release notes. Validate clean Codex and
Claude Code startup and representative calls against the exact candidate; a
published-package run at a different commit is not candidate evidence.

Before a release pull request is merged, run the standard checks in
[Testing](./testing.md), then validate package and release metadata:

```sh
pnpm run build:package
node scripts/validate-mcp-server-version.mjs
npm pack --dry-run
FRAMEKIT_TEST_MCP_ENTRYPOINT="$PWD/dist-package/apps/mcp-server/src/main.js" pnpm run test:headless
pnpm run release-gate --output-dir artifacts/release-gate/local-run
```

The release workflow runs `node scripts/validate-mcp-server-version.mjs` and
the headless suite before `npm publish`. The artifact workflow's production
MCP client starts the built package rather than the source loader. The
headless suite includes artifact-first editing, verified
Undo, FCPXML readback, and rendered-output test. Its result does not verify a
manual handoff or any native Final Cut operation; record those separately.

For v0.2.2, artifact-first editing is the required delivery scope. The
headless workflow and artifact generation gates must pass on the exact merged
candidate, with independent restoration and output checks. Manual handoff,
native observation and native mutation remain independent capabilities. The
legacy release gate reports deterministic and native tiers separately; an
unrun native tier provides no native acceptance and does not by itself block
the artifact-first verdict. Review and release approval are still required.

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

## Emergency release rollback

Use this runbook when a merged release PR may have shipped a severe regression,
unsafe native extension, exposed secret, or destructive editing behavior. A
release can be public on npm before the clean-client check, GitHub release, or
native packaging finishes. Treat those as separate distribution surfaces.
Assign an incident owner, record the affected version and commit, and announce
the incident through the project's normal channels. Tell users to stop using
the affected version while its impact is investigated. Do not post secrets,
private media, or project contents in public incident records.

### 1. Stop further distribution and establish state

1. Cancel all active or queued Release workflow runs for the affected tag,
   including native packaging and manual retries. Check their final status:
   cancellation can race with an already running publish or asset upload.
   Coordinate with maintainers to pause merges and manual release retries
   until containment is verified. The workflow has no bad-tag quarantine or
   global kill switch; cancellation alone does not prevent a new run.
2. Record the merged PR, tag, resolved commit, workflow run URLs and timestamps.
   Inspect the npm version and dist-tags, GitHub release and assets, and native
   packaging runs separately. Repeat these checks after cancellation settles.
   For example, substitute the affected tag and version below:

   ```sh
   gh run list --workflow release.yml --limit 30
   gh release view vX.Y.Z --json tagName,isDraft,isPrerelease,assets,url
   gh api repos/morshoto/framekit/releases/latest --jq .tag_name
   git ls-remote origin 'refs/tags/vX.Y.Z*'
   npm view @morshoto/framekit@X.Y.Z version dist.integrity --json
   npm view @morshoto/framekit dist-tags --json
   ```

   A failed query is not proof that publication did not happen: distinguish a
   confirmed registry 404 from authentication, network, or registry errors.
3. Select a known-good fallback from actual release evidence. Verify its npm
   version and integrity, GitHub release, and, if needed, the matching native
   archive, checksum, signature and source identity. Check its known defects
   and compatibility with the user's projects. Do not assume the preceding
   version is safe or that npm and native assets are both available.

### 2. Contain each affected surface

**npm:** If the affected version is published, an authorized npm maintainer can
move `latest` to the verified fallback and deprecate the exact bad version:

```sh
npm dist-tag add @morshoto/framekit@GOOD_VERSION latest
npm deprecate @morshoto/framekit@BAD_VERSION "Do not use: INCIDENT. Use GOOD_VERSION or a verified fixed release."
npm view @morshoto/framekit dist-tags --json
npm view @morshoto/framekit@BAD_VERSION deprecated
```

Replace every placeholder, including the message, before running these
commands. Trusted publishing grants the workflow publish access; it does not
establish that an incident responder can change dist-tags or deprecate. Verify
maintainer access in advance. Moving `latest` affects future resolution of
that tag, not already installed or cached packages, lockfiles, explicit version
pins, or all semver range resolution. Deprecation warns but does not prevent
installation. Tell affected users the exact safe version and how to update or
pin their client, and have them restart it and verify the installed version.

Prefer deprecation to unpublishing. Consider unpublishing only when continued
availability poses a greater risk than breaking consumers, and check the
[npm unpublish policy](https://docs.npmjs.com/policies/unpublish/) first. A
published package/version cannot be reused, even after unpublishing.

**GitHub and native assets:** Add a prominent warning and safe-version guidance
to the affected GitHub release. Set the verified fallback as the latest release
if appropriate, and verify what GitHub displays. If an asset is dangerous,
remove it from distribution after preserving its digest and incident evidence;
downloads and installed copies cannot be recalled. Instruct users to replace
the extension with a verified matching fallback and restart the relevant apps.
Check package/extension build alignment; a mismatched pair may fail closed.
The [GitHub release management guide](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository?tool=cli)
describes editing releases and their latest status.

**Projects and secrets:** Stop further edits to affected projects. Preserve
copies and available logs, then restore from a verified backup or use Undo only
when its applicability and result can be independently verified. Do not claim
that downgrading restores media or timelines. For a suspected credential leak,
revoke and rotate the affected credentials, investigate access, and follow the
project's security disclosure process. Removing an artifact cannot retract
copies already downloaded.

### 3. Repair, release and verify

Identify and revert or fix the actual faulty changes on `main` through a
reviewed PR; reverting the tagpr merge alone may only revert version metadata.
Preserve the release tag and incident evidence rather than moving or reusing
the tag. Quarantine the affected tag operationally: do not dispatch a retry for
it, because the existing `release_tag` input accepts reachable tags and may
publish or resume publication. Review active runs again before and after the
repair.

If the release candidate is sound and only publication infrastructure failed,
the existing-tag retry in [Validation and retries](#validation-and-retries) is
appropriate after confirming the partial publication state. If the published
candidate itself is bad, validate and publish a **new version** through the
normal release process. Verify its exact tag and commit, npm version and
dist-tags, clean-client installation, GitHub release, and native assets and
provenance separately. Perform any required headed Final Cut acceptance
separately; package or fixture checks do not establish it.

Close the incident only after containment and the chosen recovery are verified.
Record the affected and fallback versions, user impact, remaining risks,
timestamps, links to evidence and follow-up work. Notify users when a verified
fix is available, including whether they need to restore a project or replace
an installed extension.

Milestone reports are generated from explicit baseline/current coverage,
GitHub milestone activity, and the corresponding tags. Store their JSON,
Markdown, and chart assets with the draft release. Exact reruns from the same
inputs should remain reproducible.
