#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf 'Usage: %s [WORKTREE_PATH] [--manifest MANIFEST_PATH]\n' "$0" >&2
}

[[ ${1:-} == "--help" || ${1:-} == "-h" ]] && { usage; exit 0; }
worktree=.
manifest=
if (($# > 0)) && [[ $1 != --manifest ]]; then
  worktree=$1
  shift
fi
if (($# > 0)); then
  if (($# != 2)) || [[ $1 != --manifest ]]; then usage; exit 64; fi
  manifest=$2
fi

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

if [[ -n "$manifest" ]]; then
  [[ ! -e "$manifest" ]] || {
    printf 'error: manifest path already exists: %s\n' "$manifest" >&2
    exit 1
  }
  umask 077
  printf 'FRAMEKIT_CLEAN_WORKTREE_V1\t%s\n' \
    "$(git -C "$repository_root" rev-parse HEAD)" >"$manifest"

  while IFS= read -r -d '' path; do
    [[ "$path" != *$'\t'* && "$path" != *$'\n'* ]] || {
      printf 'error: manifest cannot represent path: %s\n' "$path" >&2
      rm -f -- "$manifest"
      exit 1
    }
    index_hash=$(git -C "$repository_root" ls-files -s -z -- "$path" | git hash-object --stdin)
    if [[ -e "$repository_root/$path" || -L "$repository_root/$path" ]]; then
      content_hash=$(git -C "$repository_root" hash-object --no-filters -- "$repository_root/$path")
    else
      content_hash=MISSING
    fi
    worktree_hash=$(
      {
        printf '%s\n' "$content_hash"
        git -C "$repository_root" diff --raw --no-abbrev -- "$path"
      } | git hash-object --stdin
    )
    printf '%s\t%s\t%s\n' "$path" "$index_hash" "$worktree_hash" >>"$manifest"
  done < <(git -C "$repository_root" diff --name-only -z HEAD)

  printf 'manifest=%s\n' "$manifest"
fi
