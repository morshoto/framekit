# CodeQL workflow operations

The CodeQL workflow uses one concurrency group per workflow and Git reference.
GitHub keeps at most one run running and one run pending in each group.

## Cancellation policy

Default-branch pushes, scheduled scans, and manual scans queue behind an active
run. They do not cancel an active default-branch analysis, so a routine burst of
commits cannot interrupt CodeQL while it is publishing its analysis record.

Pull-request scans cancel an older active scan for the same pull request when a
newer pull-request event arrives. This bounds work for obsolete pull-request
commits while leaving different pull requests independent.

## Pull-request path filtering

Pull requests first run the lightweight `Detect CodeQL paths` job on
`ubuntu-latest`. The JavaScript/TypeScript analysis runs when a JavaScript or
TypeScript source, its package or TypeScript configuration, the CodeQL
configuration, or this workflow changes. The Swift job always starts so its
required check remains present. When the detector succeeds and no Swift bridge,
CodeQL configuration, or workflow file changed, the job runs a successful
no-op step and skips checkout and Swift CodeQL analysis. Otherwise, the Swift
analysis runs normally.

Pushes to `main`, scheduled scans, and manual scans analyze both languages so
that path filtering does not reduce default-branch coverage. The Swift job uses
conditions inside the job rather than a job-level path filter, while the
JavaScript/TypeScript job retains its existing job-level filter. If path
detection fails, both language jobs deliberately fall back to a full scan.

The policy intentionally does not suppress genuine CodeQL failures, delete
historical analyses, or change the configured security rules and query suites.

## Verification

Status: Verified for the pull-request merge ref; post-merge `main` validation is pending.

Last verified: 2026-08-31 (Asia/Tokyo; 2026-08-30 UTC)

Environment: GitHub Actions, CodeQL v4, `javascript-typescript` on
`ubuntu-latest`, and Swift on `macos-15` with Xcode 16.4.

Scope: PR #115 merge-ref workflow run, including JavaScript and Swift analysis;
the resulting default-branch behavior still requires a post-merge run.

Expected result: The workflow completes successfully, and its analysis has a
nonzero `rules_count` with no unsuccessful-execution error.

Actual evidence: Workflow run `33327013184` completed successfully. Both
JavaScript and Swift CodeQL jobs passed. Swift extraction reported `0`
unresolved AST nodes and `410407` extracted AST nodes, then successfully
uploaded the results. The existing `main` history still contains two zero-rule
unsuccessful records; this change does not delete them.

Limitations: The PR merge-ref run cannot prove the post-merge `main` behavior.
After merge, trigger closely spaced `main` runs and inspect their workflow
conclusions and analyses API records.

After closely spaced workflow triggers, inspect both workflow conclusions and
the code-scanning analyses API. A healthy `main` analysis has a nonzero
`rules_count` and no unsuccessful-execution error:

```sh
gh run list --workflow codeql.yml --limit 20
gh api 'repos/morshoto/framekit/code-scanning/analyses?ref=refs%2Fheads%2Fmain&per_page=20'
```

Cancelled pull-request runs are expected when a newer commit supersedes them.
An unsuccessful zero-rule analysis for `main` is not an expected result.
