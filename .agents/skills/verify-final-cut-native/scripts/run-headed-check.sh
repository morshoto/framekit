#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Usage: run-headed-check.sh MODE [--execute]

Modes and required environment variables:
  canonical-read  FRAMEKIT_FINAL_CUT_E2E_PROJECT
  media-insert    FRAMEKIT_FINAL_CUT_E2E_PROJECT, FRAMEKIT_FINAL_CUT_E2E_QUERY
  canonical-write FRAMEKIT_FINAL_CUT_E2E_PROJECT, FRAMEKIT_FINAL_CUT_E2E_CLIP_ID
  disposable-edit FRAMEKIT_FINAL_CUT_E2E_PROJECT, FRAMEKIT_FINAL_CUT_E2E_CLIP_ID
  filler-removal  FRAMEKIT_FINAL_CUT_E2E_PROJECT, FRAMEKIT_FINAL_CUT_E2E_RANGE_START,
                  FRAMEKIT_FINAL_CUT_E2E_RANGE_END
  overlay         FRAMEKIT_FINAL_CUT_E2E_PROJECT

Without --execute, perform preflight only. Write modes additionally require:
  FRAMEKIT_FINAL_CUT_E2E_ALLOW_MUTATION=1
USAGE
}

[[ ${1:-} == "--help" || ${1:-} == "-h" ]] && { usage; exit 0; }
mode=${1:-}
[[ -n "$mode" ]] || { usage >&2; exit 64; }
shift

execute=0
while (($# > 0)); do
  case "$1" in
    --execute) execute=1 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 64 ;;
  esac
  shift
done

repository_root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  printf '%s\n' 'error: run from a linked Framekit worktree' >&2
  exit 1
}
source "$repository_root/.agents/skills/verify-final-cut-native/scripts/console-lock-state.sh"
[[ $(uname -s) == Darwin ]] || { printf '%s\n' 'error: headed Final Cut verification requires macOS' >&2; exit 1; }
command -v osascript >/dev/null 2>&1 || { printf '%s\n' 'error: osascript is required' >&2; exit 1; }
pgrep -x 'Final Cut Pro' >/dev/null 2>&1 || { printf '%s\n' 'error: Final Cut Pro is not running' >&2; exit 1; }

if ! command -v ioreg >/dev/null 2>&1; then
  printf '%s\n' \
    'code=FINAL_CUT_NATIVE_CONSOLE_LOCK_STATE_UNKNOWN' \
    'state=unknown' \
    'source=probe' \
    'retryable=true' \
    'guidance=Retry when ioreg is available.' >&2
  exit 75
fi
if ! lock_probe=$(ioreg -n Root -d1 2>/dev/null); then
  printf '%s\n' \
    'code=FINAL_CUT_NATIVE_CONSOLE_LOCK_STATE_UNKNOWN' \
    'state=unknown' \
    'source=probe' \
    'retryable=true' \
    'guidance=Retry when ioreg can read the console state.' >&2
  exit 75
fi
lock_result=$(console_lock_state_result "$lock_probe")
lock_state=$(printf '%s\n' "$lock_result" | sed -n 's/^state=//p')
lock_source=$(printf '%s\n' "$lock_result" | sed -n 's/^source=//p')
case "$lock_state" in
  unlocked)
    printf 'console_lock_state=unlocked\nconsole_lock_source=%s\n' "$lock_source"
    ;;
  locked)
    printf '%s\n' \
      'code=FINAL_CUT_NATIVE_CONSOLE_LOCKED' \
      'state=locked' \
      "source=$lock_source" \
      'retryable=false' \
      'guidance=Unlock the console before native verification.' >&2
    exit 1
    ;;
  *)
    printf '%s\n' \
      'code=FINAL_CUT_NATIVE_CONSOLE_LOCK_STATE_UNKNOWN' \
      'state=unknown' \
      "source=$lock_source" \
      'retryable=true' \
      'guidance=Retry when macOS exposes one consistent supported lock-state signal.' >&2
    exit 75
    ;;
esac

frontmost=$(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>/dev/null || printf unavailable)
printf 'worktree=%s\nhead=%s\nfrontmost=%s\n' "$repository_root" "$(git -C "$repository_root" rev-parse HEAD)" "$frontmost"
[[ "$frontmost" == 'Final Cut Pro' ]] || {
  printf '%s\n' 'error: Final Cut Pro must be frontmost with a visible timeline' >&2
  exit 1
}

require_env() {
  local variable
  for variable in "$@"; do
    [[ -n ${!variable:-} ]] || { printf 'error: set %s\n' "$variable" >&2; exit 1; }
  done
}

write_mode=1
case "$mode" in
  canonical-read)
    write_mode=0
    require_env FRAMEKIT_FINAL_CUT_E2E_PROJECT
    runner=(pnpm run test:final-cut-canonical-read-headed)
    ;;
  media-insert)
    require_env FRAMEKIT_FINAL_CUT_E2E_PROJECT FRAMEKIT_FINAL_CUT_E2E_QUERY
    runner=(node scripts/final-cut-headed-e2e.mjs)
    ;;
  canonical-write)
    require_env FRAMEKIT_FINAL_CUT_E2E_PROJECT FRAMEKIT_FINAL_CUT_E2E_CLIP_ID
    runner=(pnpm run test:final-cut-canonical-headed)
    ;;
  disposable-edit)
    require_env FRAMEKIT_FINAL_CUT_E2E_PROJECT FRAMEKIT_FINAL_CUT_E2E_CLIP_ID
    runner=(pnpm run test:final-cut-disposable-headed)
    ;;
  filler-removal)
    require_env FRAMEKIT_FINAL_CUT_E2E_PROJECT FRAMEKIT_FINAL_CUT_E2E_RANGE_START FRAMEKIT_FINAL_CUT_E2E_RANGE_END
    runner=(pnpm run test:final-cut-filler-headed)
    ;;
  overlay)
    require_env FRAMEKIT_FINAL_CUT_E2E_PROJECT
    runner=(pnpm run test:final-cut-overlay-headed)
    ;;
  *) usage >&2; exit 64 ;;
esac

printf 'mode=%s\nexecute=%s\nwrite_mode=%s\n' "$mode" "$execute" "$write_mode"
if ((!execute)); then
  printf '%s\n' 'PREFLIGHT PASS; no headed scenario was executed.'
  exit 0
fi

if ((write_mode)) && [[ ${FRAMEKIT_FINAL_CUT_E2E_ALLOW_MUTATION:-0} != 1 ]]; then
  printf '%s\n' 'error: write mode requires FRAMEKIT_FINAL_CUT_E2E_ALLOW_MUTATION=1 for an authorized disposable project' >&2
  exit 1
fi

cd "$repository_root"
printf 'running='; printf '%q ' "${runner[@]}"; printf '\n'
"${runner[@]}"
