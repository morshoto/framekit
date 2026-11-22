#!/usr/bin/env bash
set -euo pipefail

version=1.7.12
case "$(uname -s)" in
  Darwin) platform=darwin ;;
  Linux) platform=linux ;;
  *) echo 'Workflow syntax validation supports macOS and Linux.' >&2; exit 2 ;;
esac
case "$(uname -m)" in
  x86_64) architecture=amd64 ;;
  arm64|aarch64) architecture=arm64 ;;
  *) echo 'Workflow syntax validation requires amd64 or arm64.' >&2; exit 2 ;;
esac
archive="actionlint_${version}_${platform}_${architecture}.tar.gz"
checksums="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/actionlint-checksums.txt"
work_directory=$(mktemp -d)
trap 'rm -rf "$work_directory"' EXIT
curl --fail --silent --show-error --location --connect-timeout 10 --max-time 60 --retry 2 \
  "https://github.com/rhysd/actionlint/releases/download/v${version}/${archive}" -o "$work_directory/$archive"
# Verify the pinned release digest before extracting or executing downloaded code.
(cd "$work_directory" && if [[ "$platform" == "linux" ]]; then
  awk -v archive="$archive" '$2 == archive' "$checksums" | sha256sum --check
else
  awk -v archive="$archive" '$2 == archive' "$checksums" | shasum -a 256 --check
fi)
tar -xzf "$work_directory/$archive" -C "$work_directory" actionlint
"$work_directory/actionlint" -shellcheck= "$@"
