#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf 'Usage: %s WORKTREE_PATH -- TRACKED_PATH...\n' "$0" >&2
}

[[ ${1:-} == "--help" || ${1:-} == "-h" ]] && { usage; exit 0; }
if (($# < 3)) || [[ ${2:-} != -- ]]; then usage; exit 64; fi

worktree=$1
shift 2
repository_root=$(git -C "$worktree" rev-parse --show-toplevel 2>/dev/null) || {
  printf 'error: not a linked Git worktree: %s\n' "$worktree" >&2
  exit 1
}

paths=()
for path in "$@"; do
  [[ "$path" != /* ]] || { printf 'error: absolute path refused: %s\n' "$path" >&2; exit 64; }
  [[ "/$path/" != *"/../"* ]] || { printf 'error: parent traversal refused: %s\n' "$path" >&2; exit 64; }
  [[ "$path" != . && "$path" != */ && "$path" != *$'\n'* ]] || {
    printf 'error: broad or ambiguous path refused: %s\n' "$path" >&2
    exit 64
  }
  tracked_path=$(git -C "$repository_root" ls-files --error-unmatch -- "$path" 2>/dev/null) || {
    printf 'error: path is not tracked: %s\n' "$path" >&2
    exit 1
  }
  [[ "$tracked_path" == "$path" ]] || {
    printf 'error: path must name exactly one tracked file: %s\n' "$path" >&2
    exit 64
  }
  [[ -n $(git -C "$repository_root" status --porcelain -- "$path") ]] || {
    printf 'error: path has no tracked change: %s\n' "$path" >&2
    exit 1
  }
  paths+=("$path")
done

printf '%s\n' '=== restoring explicit tracked paths ==='
printf '%s\n' "${paths[@]}"
git -C "$repository_root" restore --staged --worktree -- "${paths[@]}"

printf '%s\n' '=== resulting status ==='
git -C "$repository_root" status --short --branch
