#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf 'Usage: %s OWNER/REPO ISSUE_NUMBER_OR_URL\n' "$0" >&2
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

if [[ ${1:-} == "--help" || ${1:-} == "-h" ]]; then
  usage
  exit 0
fi

if (($# != 2)); then
  usage
  exit 64
fi

command -v gh >/dev/null 2>&1 || die "gh is required"
command -v git >/dev/null 2>&1 || die "git is required"

repo=$1
issue=$2
owner=${repo%%/*}
name=${repo#*/}
[[ -n "$owner" && -n "$name" && "$name" != */* ]] || die "repository must be OWNER/REPO"
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repository_root=$(cd -- "$script_dir/../../../.." && pwd)
issue_reader="$repository_root/.agents/skills/issue-read/scripts/read-issue.sh"

[[ -x "$issue_reader" ]] || die "issue reader is unavailable: $issue_reader"

printf '%s\n' '=== repository ==='
gh repo view "$repo" --json nameWithOwner,url,defaultBranchRef

printf '%s\n' '=== live issue ==='
"$issue_reader" "$repo" "$issue"

printf '%s\n' '=== linked pull requests ==='
gh issue view "$issue" --repo "$repo" \
  --json closedByPullRequestsReferences \
  --jq '.closedByPullRequestsReferences[]? | select(.number != null) | {number,title,state,url}'
issue_number=$(gh issue view "$issue" --repo "$repo" --json number --jq .number)
gh api graphql \
  -F owner="$owner" \
  -F name="$name" \
  -F number="$issue_number" \
  -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){timelineItems(first:100,itemTypes:[CROSS_REFERENCED_EVENT]){nodes{... on CrossReferencedEvent{source{... on PullRequest{number title state url}}}}}}}}' \
  --jq '.data.repository.issue.timelineItems.nodes[]?.source // empty'

printf '%s\n' '=== local worktrees ==='
git -C "$repository_root" worktree list --porcelain

printf '%s\n' '=== delivery reminder ==='
printf '%s\n' 'Map acceptance criteria to tests; use an isolated worktree; validate before a non-draft PR.'
