#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: %s OWNER/REPO ISSUE_NUMBER_OR_URL\n' "$0" >&2
}

if [[ ${1:-} == "--help" || ${1:-} == "-h" ]]; then
  usage
  exit 0
fi

if (($# != 2)); then
  usage
  exit 64
fi

repo=$1
issue=$2
gh issue view "$issue" --repo "$repo" --comments \
  --json number,title,body,state,labels,assignees,milestone,comments,url
