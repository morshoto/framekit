#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf 'Usage: %s OWNER/REPO (--pr PR_NUMBER | --run RUN_ID)\n' "$0" >&2
}

[[ ${1:-} == "--help" || ${1:-} == "-h" ]] && { usage; exit 0; }
if (($# != 3)); then usage; exit 64; fi

repo=$1
kind=$2
target=$3
command -v gh >/dev/null 2>&1 || { printf '%s\n' 'error: gh is required' >&2; exit 1; }

case "$kind" in
  --pr)
    printf '%s\n' '=== pull request ==='
    gh pr view "$target" --repo "$repo" \
      --json number,title,url,state,mergeable,mergeStateStatus,headRefName,headRefOid,baseRefName,statusCheckRollup
    printf '%s\n' '=== checks ==='
    gh pr checks "$target" --repo "$repo" || true
    head_branch=$(gh pr view "$target" --repo "$repo" --json headRefName --jq .headRefName)
    printf '%s\n' '=== recent branch runs ==='
    gh run list --repo "$repo" --branch "$head_branch" --limit 10 \
      --json databaseId,workflowName,event,status,conclusion,headSha,createdAt,updatedAt,url
    ;;
  --run)
    printf '%s\n' '=== workflow run ==='
    gh run view "$target" --repo "$repo" \
      --json databaseId,name,event,status,conclusion,headBranch,headSha,createdAt,updatedAt,url,jobs
    printf '%s\n' '=== failed logs ==='
    gh run view "$target" --repo "$repo" --log-failed || true
    ;;
  *) usage; exit 64 ;;
esac
