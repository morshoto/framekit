#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${FRAMEKIT_CODESIGN_IDENTITY:-}" || "${FRAMEKIT_CODESIGN_IDENTITY}" == "-" ]]; then
  echo "FRAMEKIT_CODESIGN_IDENTITY must contain a Developer ID signing identity" >&2
  exit 2
fi

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output_dir="${FRAMEKIT_RELEASE_DIR:-$project_root/.release}"
archive_name="FramekitFinalCutWorkflow-${FRAMEKIT_RELEASE_VERSION:-0.1.0}.zip"
product="/tmp/framekit-finalcut-derived/Build/Products/Debug/FramekitFinalCutWorkflow.app"

FRAMEKIT_CODESIGN_REQUIRED=YES \
  bash "$project_root/adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/build.sh"

codesign --verify --deep --strict "$product"
mkdir -p "$output_dir"
ditto -c -k --sequesterRsrc --keepParent "$product" "$output_dir/$archive_name"
shasum -a 256 "$output_dir/$archive_name" > "$output_dir/$archive_name.sha256"

if [[ -n "${FRAMEKIT_NOTARY_PROFILE:-}" ]]; then
  xcrun notarytool submit "$output_dir/$archive_name" \
    --keychain-profile "$FRAMEKIT_NOTARY_PROFILE" \
    --wait
  xcrun stapler staple "$product"
  codesign --verify --deep --strict "$product"
  ditto -c -k --sequesterRsrc --keepParent "$product" "$output_dir/$archive_name"
  shasum -a 256 "$output_dir/$archive_name" > "$output_dir/$archive_name.sha256"
fi

echo "Release artifact: $output_dir/$archive_name"
echo "Checksum: $output_dir/$archive_name.sha256"
