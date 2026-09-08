#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf 'Usage: %s [--full]\n' "$0" >&2
}

full=0
while (($# > 0)); do
  case "$1" in
    --full) full=1 ;;
    --help|-h) usage; exit 0 ;;
    *) usage; exit 64 ;;
  esac
  shift
done

repository_root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  printf '%s\n' 'error: run from a linked Framekit worktree' >&2
  exit 1
}

if [[ -n ${FRAMEKIT_TOOL_BIN:-} ]]; then
  export PATH="$FRAMEKIT_TOOL_BIN:$PATH"
elif [[ -d ${HOME:-}/.nix-profile/bin ]]; then
  export PATH="${HOME}/.nix-profile/bin:$PATH"
fi
command -v pnpm >/dev/null 2>&1 || { printf '%s\n' 'error: pnpm is required' >&2; exit 1; }

step=preflight
trap 'status=$?; printf "FAILED step=%s exit=%s\n" "$step" "$status" >&2; exit "$status"' ERR
run() {
  step=$1
  shift
  printf '\n=== %s ===\n' "$step"
  "$@"
}

cd "$repository_root"
printf 'worktree=%s\nhead=%s\n' "$repository_root" "$(git rev-parse HEAD)"
run build pnpm run build
run mcp-evaluation pnpm run evaluate
run final-cut-headless pnpm run test:final-cut-headless
run boundaries pnpm run check:boundaries
if ((full)); then
  run full-test pnpm run test
fi

trap - ERR
printf '\nPASS evidence=deterministic-contract\n'
printf '%s\n' 'NOTE: real MCP calls and headed Final Cut proof remain separate.'
