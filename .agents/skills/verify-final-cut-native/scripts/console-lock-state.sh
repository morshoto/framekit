#!/usr/bin/env bash
set -Eeuo pipefail

console_lock_state_result() {
  local probe=${1:-}
  local current_state legacy_state
  current_state=$(printf '%s\n' "$probe" | sed -n \
    's/.*"IOConsoleLocked"[[:space:]]*=[[:space:]]*\([^,}[:space:]]*\).*/\1/p' | head -n 1)
  legacy_state=$(printf '%s\n' "$probe" | sed -n \
    's/.*"CGSSessionScreenIsLocked"[[:space:]]*=[[:space:]]*\([^,}[:space:]]*\).*/\1/p' | head -n 1)

  if [[ -n "$current_state" && "$current_state" != No && "$current_state" != Yes ]]; then
    printf 'state=unknown\nsource=IOConsoleLocked\nretryable=true\n'
  elif [[ -n "$legacy_state" && "$legacy_state" != No && "$legacy_state" != Yes ]]; then
    printf 'state=unknown\nsource=CGSSessionScreenIsLocked\nretryable=true\n'
  elif [[ -n "$current_state" && -n "$legacy_state" && "$current_state" != "$legacy_state" ]]; then
    printf 'state=unknown\nsource=conflict\nretryable=true\n'
  elif [[ "$current_state" == No || "$legacy_state" == No ]]; then
    printf 'state=unlocked\nsource=%s\nretryable=false\n' \
      "$([[ -n "$current_state" ]] && printf IOConsoleLocked || printf CGSSessionScreenIsLocked)"
  elif [[ "$current_state" == Yes || "$legacy_state" == Yes ]]; then
    printf 'state=locked\nsource=%s\nretryable=false\n' \
      "$([[ -n "$current_state" ]] && printf IOConsoleLocked || printf CGSSessionScreenIsLocked)"
  else
    printf 'state=unknown\nsource=none\nretryable=true\n'
  fi
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  probe=$(cat)
  console_lock_state_result "$probe"
fi
