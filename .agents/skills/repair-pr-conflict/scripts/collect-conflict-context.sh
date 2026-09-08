#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf 'Usage: %s OWNER/REPO PR_NUMBER\n' "$0" >&2
}

[[ ${1:-} == "--help" || ${1:-} == "-h" ]] && { usage; exit 0; }
if (($# != 2)); then usage; exit 64; fi

repo=$1
pr=$2
command -v gh >/dev/null 2>&1 || { printf '%s\n' 'error: gh is required' >&2; exit 1; }

printf '%s\n' '=== live pull request ==='
gh pr view "$pr" --repo "$repo" \
  --json number,title,url,state,isDraft,mergeable,mergeStateStatus,headRefName,headRefOid,baseRefName,headRepositoryOwner

printf '%s\n' '=== changed paths ==='
gh pr diff "$pr" --repo "$repo" --name-only

printf '%s\n' '=== checks ==='
gh pr checks "$pr" --repo "$repo" || true

printf '%s\n' '=== local worktrees ==='
if git rev-parse --git-dir >/dev/null 2>&1; then
  git worktree list --porcelain
else
  printf '%s\n' 'unavailable: run inside the repository to inspect worktrees'
fi
