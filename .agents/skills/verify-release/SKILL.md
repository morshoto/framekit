---
name: verify-release
description: Verify a Framekit release across the Git tag, GitHub release state, required workflow runs, Workflow Extension archive and checksum assets, npm registry publication, and clean-client startup evidence. Use for release status, draft-release problems, tagpr questions, missing npm versions, or requests to confirm that a release is actually available to users.
---

# Verify a Framekit release

Run the cross-surface verifier with an exact version:

```sh
.agents/skills/verify-release/scripts/verify-release.sh OWNER/REPO VERSION [NPM_PACKAGE]
```

The helper exits nonzero when the tag, GitHub release, expected native assets, or npm version is missing. It does not mutate tags, releases, workflows, or npm account settings.

## Complete verification

1. Confirm the tag resolves to the intended commit.
2. Confirm the GitHub release draft/prerelease state and matching target.
3. Confirm `FramekitFinalCutWorkflow-VERSION.zip` and its `.sha256` asset exist.
4. Confirm the `Release` workflow reached a terminal successful conclusion for the exact tag commit.
5. Confirm `npm view --registry=https://registry.npmjs.org PACKAGE@VERSION version` returns the exact version.
6. When end-user availability is the goal, run package/plugin and clean-client smoke tests against the published package.

Keep repository workflow correctness separate from external npm Trusted Publisher or authentication state. A tag, release, or green build does not prove registry publication; registry publication does not prove a clean client can start the MCP server.
