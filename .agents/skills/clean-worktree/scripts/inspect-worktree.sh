#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf 'Usage: %s [WORKTREE_PATH]\n' "$0" >&2
}

[[ ${1:-} == "--help" || ${1:-} == "-h" ]] && { usage; exit 0; }
if (($# > 1)); then usage; exit 64; fi
worktree=${1:-.}

repository_root=$(git -C "$worktree" rev-parse --show-toplevel 2>/dev/null) || {
  printf 'error: not a linked Git worktree: %s\n' "$worktree" >&2
  exit 1
}

printf 'worktree=%s\nhead=%s\n' "$repository_root" "$(git -C "$repository_root" rev-parse HEAD)"
printf '%s\n' '=== status ==='
git -C "$repository_root" status --short --branch
printf '%s\n' '=== unstaged summary ==='
git -C "$repository_root" diff --stat
printf '%s\n' '=== staged summary ==='
git -C "$repository_root" diff --cached --stat
printf '%s\n' '=== upstream divergence ==='
if upstream=$(git -C "$repository_root" rev-parse --abbrev-ref '@{upstream}' 2>/dev/null); then
  counts=$(git -C "$repository_root" rev-list --left-right --count "$upstream...HEAD")
  printf 'upstream=%s behind_ahead=%s\n' "$upstream" "$counts"
else
  printf '%s\n' 'upstream=none'
fi
