#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: %s OWNER/REPO PR_NUMBER\n' "$0" >&2
}

if (($# != 2)); then
  usage
  exit 64
fi

repo=$1
pr=$2

printf '%s\n' '=== metadata ==='
gh pr view "$pr" --repo "$repo" \
  --json title,body,files,url,headRefName,baseRefName,headRefOid
printf '%s\n' '=== diff ==='
gh pr diff "$pr" --repo "$repo"
printf '%s\n' '=== conversation ==='
gh pr view "$pr" --repo "$repo" --comments
printf '%s\n' '=== inline review comments ==='
gh api "repos/$repo/pulls/$pr/comments" --paginate \
  --jq '.[] | {file: .path, user: .user.login, comment: .body, line: .line, side: .side}'
printf '%s\n' '=== checks ==='
gh pr checks "$pr" --repo "$repo"
