#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf 'Usage: %s WORKTREE_PATH --manifest MANIFEST_PATH -- TRACKED_PATH...\n' "$0" >&2
}

[[ ${1:-} == "--help" || ${1:-} == "-h" ]] && { usage; exit 0; }
if (($# < 5)) || [[ ${2:-} != --manifest || ${4:-} != -- ]]; then usage; exit 64; fi

worktree=$1
manifest=$3
shift 4
repository_root=$(git -C "$worktree" rev-parse --show-toplevel 2>/dev/null) || {
  printf 'error: not a linked Git worktree: %s\n' "$worktree" >&2
  exit 1
}
[[ -f "$manifest" ]] || { printf 'error: manifest not found: %s\n' "$manifest" >&2; exit 1; }

IFS=$'\t' read -r manifest_version expected_head manifest_extra <"$manifest" || {
  printf 'error: unreadable authorization manifest: %s\n' "$manifest" >&2
  exit 1
}
[[ "$manifest_version" == FRAMEKIT_CLEAN_WORKTREE_V1 && -n "$expected_head" && -z "$manifest_extra" ]] || {
  printf 'error: invalid authorization manifest: %s\n' "$manifest" >&2
  exit 1
}
[[ $(git -C "$repository_root" rev-parse HEAD) == "$expected_head" ]] || {
  printf '%s\n' 'error: HEAD changed after inspection; inspect and authorize again' >&2
  exit 1
}

current_index_hash() {
  git -C "$repository_root" ls-files -s -z -- "$1" | git hash-object --stdin
}

current_worktree_hash() {
  local content_hash
  if [[ -e "$repository_root/$1" || -L "$repository_root/$1" ]]; then
    content_hash=$(git -C "$repository_root" hash-object --no-filters -- "$repository_root/$1")
  else
    content_hash=MISSING
  fi
  {
    printf '%s\n' "$content_hash"
    git -C "$repository_root" diff --raw --no-abbrev -- "$1"
  } | git hash-object --stdin
}

verify_authorized_content() {
  local position path expected_index expected_worktree
  [[ $(git -C "$repository_root" rev-parse HEAD) == "$expected_head" ]] || {
    printf '%s\n' 'error: HEAD changed after inspection; inspect and authorize again' >&2
    return 1
  }
  for ((position = 0; position < ${#paths[@]}; position++)); do
    path=${paths[position]}
    expected_index=${index_hashes[position]}
    expected_worktree=${worktree_hashes[position]}
    if [[ $(current_index_hash "$path") != "$expected_index" || \
          $(current_worktree_hash "$path") != "$expected_worktree" ]]; then
      printf 'error: content changed after inspection: %s\n' "$path" >&2
      return 1
    fi
  done
}

paths=()
index_hashes=()
worktree_hashes=()
selected_paths=$'\n'
for path in "$@"; do
  [[ "$path" != /* ]] || { printf 'error: absolute path refused: %s\n' "$path" >&2; exit 64; }
  [[ "/$path/" != *"/../"* ]] || { printf 'error: parent traversal refused: %s\n' "$path" >&2; exit 64; }
  [[ "$path" != . && "$path" != */ && "$path" != *$'\n'* && "$path" != *$'\t'* ]] || {
    printf 'error: broad or ambiguous path refused: %s\n' "$path" >&2
    exit 64
  }
  tracked_path=$(git -C "$repository_root" ls-files --error-unmatch -- "$path" 2>/dev/null) ||
    tracked_path=$(git -C "$repository_root" cat-file -e "HEAD:$path" 2>/dev/null && printf '%s' "$path") || {
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
  [[ "$selected_paths" != *$'\n'"$path"$'\n'* ]] || {
    printf 'error: duplicate path refused: %s\n' "$path" >&2
    exit 64
  }

  manifest_match=
  while IFS=$'\t' read -r manifest_path expected_index expected_worktree extra; do
    [[ "$manifest_path" != "$path" ]] || {
      [[ -n "$expected_index" && -n "$expected_worktree" && -z "$extra" && -z "$manifest_match" ]] || {
        printf 'error: invalid manifest entry for: %s\n' "$path" >&2
        exit 1
      }
      manifest_match=1
      index_hashes+=("$expected_index")
      worktree_hashes+=("$expected_worktree")
    }
  done < <(tail -n +2 -- "$manifest")
  [[ -n "$manifest_match" ]] || {
    printf 'error: path was not present during inspection: %s\n' "$path" >&2
    exit 1
  }
  paths+=("$path")
  selected_paths+="$path"$'\n'
done

lock_path=$(git -C "$repository_root" rev-parse --path-format=absolute --git-path framekit-clean-worktree.lock)
mkdir "$lock_path" 2>/dev/null || {
  printf '%s\n' 'error: another clean-worktree restore is active' >&2
  exit 1
}
trap 'rmdir -- "$lock_path" 2>/dev/null || true' EXIT

verify_authorized_content

backup_root=$(git -C "$repository_root" rev-parse --path-format=absolute --git-path framekit-clean-worktree-backups)
backup_dir="$backup_root/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p -- "$backup_dir"
git -C "$repository_root" diff --cached --binary -- "${paths[@]}" >"$backup_dir/staged.patch"
git -C "$repository_root" diff --binary -- "${paths[@]}" >"$backup_dir/worktree.patch"
cp -- "$manifest" "$backup_dir/manifest.tsv"

# Detect edits made while the recoverable backup was being written.
verify_authorized_content

printf '%s\n' '=== restoring explicit tracked paths ==='
printf '%s\n' "${paths[@]}"
git -C "$repository_root" restore --staged --worktree -- "${paths[@]}"
printf 'backup=%s\n' "$backup_dir"
printf 'recovery=git apply --index %q && git apply %q\n' \
  "$backup_dir/staged.patch" "$backup_dir/worktree.patch"

printf '%s\n' '=== resulting status ==='
git -C "$repository_root" status --short --branch
