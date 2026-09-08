#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Usage: validate.sh [--native] [--skip-install]

  --native        Also run the Xcode/native validation gates.
  --skip-install  Skip pnpm install only when already proven for this worktree.
USAGE
}

native=0
install=1
while (($# > 0)); do
  case "$1" in
    --native) native=1 ;;
    --skip-install) install=0 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 64 ;;
  esac
  shift
done

repository_root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  printf '%s\n' 'error: run this helper from a linked Git worktree, not the bare Framekit root' >&2
  exit 1
}

if [[ -n ${FRAMEKIT_TOOL_BIN:-} ]]; then
  export PATH="$FRAMEKIT_TOOL_BIN:$PATH"
elif [[ -d ${HOME:-}/.nix-profile/bin ]]; then
  export PATH="${HOME}/.nix-profile/bin:$PATH"
fi

command -v pnpm >/dev/null 2>&1 || {
  printf '%s\n' 'error: pnpm is required; set FRAMEKIT_TOOL_BIN to the intended toolchain bin directory' >&2
  exit 1
}

current_step=preflight
on_error() {
  status=$?
  printf 'FAILED step=%s exit=%s\n' "$current_step" "$status" >&2
  exit "$status"
}
trap on_error ERR

run_step() {
  current_step=$1
  shift
  printf '\n=== %s ===\n' "$current_step"
  "$@"
}

cd "$repository_root"
printf 'worktree=%s\n' "$repository_root"
printf 'head=%s\n' "$(git rev-parse HEAD)"
printf 'node=%s\n' "$(command -v node || printf unavailable)"
printf 'pnpm=%s\n' "$(command -v pnpm)"

if ((install)); then
  run_step install pnpm install --frozen-lockfile
else
  printf '\n=== install ===\nSKIPPED by --skip-install\n'
fi
run_step build pnpm run build
run_step test pnpm run test
run_step boundaries pnpm run check:boundaries

if ((native)); then
  run_step xcode-check pnpm run xcode:check
  run_step xcode-project-list xcodebuild \
    -project adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/FramekitFinalCutWorkflow.xcodeproj \
    -list
else
  printf '\n=== native ===\nSKIPPED; rerun with --native when native files changed\n'
fi

trap - ERR
printf '\nPASS head=%s native=%s\n' "$(git rev-parse HEAD)" "$native"
