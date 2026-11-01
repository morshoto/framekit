#!/usr/bin/env bash
# Keep manual-build inputs identical for untraced and CodeQL-traced measurements.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

args=(
  -typecheck
  -parse-as-library
  -module-name FramekitFinalCutWorkflowCodeQL
  -target "$(uname -m)-apple-macos15.0"
  -swift-version 5
  -D FRAMEKIT_CODEQL
)

# Profiling compares fresh, equivalent Swift module caches before and after
# CodeQL initialization. Normal analysis keeps the compiler's default cache.
if [[ "${FRAMEKIT_SWIFT_TYPECHECK_PROFILE:-false}" == "true" ]]; then
  if [[ -z "${RUNNER_TEMP:-}" ]]; then
    printf 'Swift CodeQL profiling requires RUNNER_TEMP\n' >&2
    exit 2
  fi
  module_cache_path="${RUNNER_TEMP%/}/framekit-swift-module-cache"
  rm -rf -- "$module_cache_path"
  mkdir -p -- "$module_cache_path"
  args+=(-module-cache-path "$module_cache_path")
fi

# Diagnostic output can be noisy; enable only for an explicit profiling run.
if [[ "${FRAMEKIT_SWIFT_TYPECHECK_DIAGNOSTICS:-false}" == "true" ]]; then
  args+=(-Xfrontend -debug-time-function-bodies)
fi

args+=(
  adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/FinalCutLiveWorkflowExtension.swift
  .github/codeql/FinalCutWorkflowExtensionShim.swift
)

started_at="$(date +%s)"
printf 'Swift CodeQL type-check started (diagnostics=%s)\n' "${FRAMEKIT_SWIFT_TYPECHECK_DIAGNOSTICS:-false}" >&2
if xcrun --sdk macosx swiftc "${args[@]}"; then
  status=0
else
  status=$?
fi
elapsed="$(( $(date +%s) - started_at ))"
printf 'Swift CodeQL type-check elapsed=%ss exit=%s\n' "$elapsed" "$status" >&2
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '| Swift compiler (diagnostics: %s) | %ss | %s |\n' \
    "${FRAMEKIT_SWIFT_TYPECHECK_DIAGNOSTICS:-false}" "$elapsed" "$status" >> "$GITHUB_STEP_SUMMARY"
fi
exit "$status"
