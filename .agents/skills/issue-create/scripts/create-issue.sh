#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: %s OWNER/REPO TITLE BODY_FILE [--label LABEL]...\n' "$0" >&2
}

if (($# < 3)); then
  usage
  exit 64
fi

repo=$1
title=$2
body_file=$3
shift 3

if [[ ! -f "$body_file" ]]; then
  printf 'Body file does not exist: %s\n' "$body_file" >&2
  exit 66
fi

args=(gh issue create --repo "$repo" --title "$title" --body-file "$body_file")
while (($# > 0)); do
  if [[ "$1" != "--label" || $# -lt 2 ]]; then
    usage
    exit 64
  fi
  args+=(--label "$2")
  shift 2
done

"${args[@]}"
