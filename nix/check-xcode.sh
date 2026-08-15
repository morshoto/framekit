#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
manifest="$repo_root/nix/xcode-version.json"

expected_xcode="$(node -e 'const m=require(process.argv[1]); process.stdout.write(m.target.xcode.version)' "$manifest")"
expected_sdk="$(node -e 'const m=require(process.argv[1]); process.stdout.write(m.target.macOSSDK)' "$manifest")"

developer_dir="$(xcode-select -p 2>/dev/null || true)"
if [[ "$developer_dir" != */Xcode*.app/Contents/Developer ]]; then
  echo "Xcode check failed: full Xcode is not selected."
  echo "  selected developer directory: ${developer_dir:-<none>}"
  echo "  expected Xcode version: $expected_xcode"
  exit 2
fi

xcode_version_output="$(xcodebuild -version)"
actual_xcode="$(awk '/^Xcode / { print $2; exit }' <<<"$xcode_version_output")"
actual_build="$(awk '/^Build version / { print $3; exit }' <<<"$xcode_version_output")"
actual_sdk="$(xcrun --sdk macosx --show-sdk-version)"

failed=0
if [[ "$actual_xcode" != "$expected_xcode" ]]; then
  echo "Xcode version mismatch: expected $expected_xcode, found ${actual_xcode:-<unknown>}"
  failed=1
fi
if [[ "$actual_sdk" != "$expected_sdk" ]]; then
  echo "macOS SDK mismatch: expected $expected_sdk, found ${actual_sdk:-<unknown>}"
  failed=1
fi

if (( failed != 0 )); then
  echo "Xcode build: ${actual_build:-<unknown>}"
  exit 1
fi

echo "Xcode $actual_xcode ($actual_build), macOS SDK $actual_sdk"
