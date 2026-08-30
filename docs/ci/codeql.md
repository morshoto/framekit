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

The policy intentionally does not suppress genuine CodeQL failures, delete
historical analyses, or change the configured security rules and query suites.

## Verification

After closely spaced workflow triggers, inspect both workflow conclusions and
the code-scanning analyses API. A healthy `main` analysis has a nonzero
`rules_count` and no unsuccessful-execution error:

```sh
gh run list --workflow codeql.yml --limit 20
gh api 'repos/morshoto/framekit/code-scanning/analyses?ref=refs%2Fheads%2Fmain&per_page=20'
```

Cancelled pull-request runs are expected when a newer commit supersedes them.
An unsuccessful zero-rule analysis for `main` is not an expected result.
