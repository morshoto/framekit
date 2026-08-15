#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
final_cut_app="${FINAL_CUT_APP:-/Applications/Final Cut Pro.app}"
frameworks="${final_cut_app}/Contents/Frameworks"
framework_link="/tmp/playhead-finalcut-frameworks"

if [[ ! -d "$frameworks/ProExtensionHost.framework" ]]; then
  echo "Final Cut Pro ProExtensionHost.framework not found: $frameworks" >&2
  exit 2
fi

ln -sfn "$frameworks" "$framework_link"
xcodegen generate --spec "$project_root/project.yml"
xcodebuild \
  -project "$project_root/PlayheadFinalCutWorkflow.xcodeproj" \
  -scheme PlayheadFinalCutWorkflow \
  -configuration Debug \
  -derivedDataPath /tmp/playhead-finalcut-derived \
  build \
  CODE_SIGN_IDENTITY=- \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGNING_ALLOWED=YES

# The build uses a space-free symlink so XcodeGen can link the embedded Final
# Cut frameworks reliably. Do not ship that temporary path in the extension's
# runtime search path: Final Cut/XProtect must resolve the host frameworks from
# the actual application bundle.
product_root="/tmp/playhead-finalcut-derived/Build/Products/Debug"
container_app="$product_root/PlayheadFinalCutWorkflow.app"
extension_bundle="$container_app/Contents/PlugIns/PlayheadFinalCutWorkflowExtension.appex"
extension_binary="$extension_bundle/Contents/MacOS/PlayheadFinalCutWorkflowExtension"
container_entitlements="$project_root/Container/Container.entitlements"
extension_entitlements="$project_root/FinalCutWorkflowExtension.entitlements"
install_name_tool -delete_rpath "$framework_link" "$extension_binary" 2>/dev/null || true
if ! otool -l "$extension_binary" | grep -Fq "path $frameworks"; then
  install_name_tool -add_rpath "$frameworks" "$extension_binary"
fi
codesign --force --sign - --entitlements "$extension_entitlements" --timestamp=none "$extension_binary"
codesign --force --sign - --entitlements "$extension_entitlements" --timestamp=none "$extension_bundle"
codesign --force --sign - --entitlements "$container_entitlements" --timestamp=none "$container_app"
codesign --verify --deep --strict "$container_app"
