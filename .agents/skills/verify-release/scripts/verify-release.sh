#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf 'Usage: %s OWNER/REPO VERSION [NPM_PACKAGE]\n' "$0" >&2
}

[[ ${1:-} == "--help" || ${1:-} == "-h" ]] && { usage; exit 0; }
if (($# < 2 || $# > 3)); then usage; exit 64; fi

repo=$1
version=${2#v}
package=${3:-}
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || {
  printf 'error: invalid version: %s\n' "$version" >&2
  exit 64
}
tag="v$version"

command -v gh >/dev/null 2>&1 || { printf '%s\n' 'error: gh is required' >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { printf '%s\n' 'error: npm is required' >&2; exit 1; }

if [[ -z "$package" ]]; then
  repository_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
  if [[ -n "$repository_root" && -f "$repository_root/package.json" ]] && command -v node >/dev/null 2>&1; then
    package=$(node -p "require(process.argv[1]).name" "$repository_root/package.json")
  else
    package=@morshoto/framekit
  fi
fi

failures=0
printf 'repo=%s\ntag=%s\npackage=%s\n' "$repo" "$tag" "$package"

printf '%s\n' '=== tag ==='
if ! gh api "repos/$repo/git/ref/tags/$tag" --jq '{ref, object}'; then
  printf 'MISSING tag=%s\n' "$tag" >&2
  failures=$((failures + 1))
fi

printf '%s\n' '=== GitHub release ==='
release_json=$(gh release view "$tag" --repo "$repo" \
  --json tagName,targetCommitish,isDraft,isPrerelease,publishedAt,url,assets 2>/dev/null) || release_json=
if [[ -z "$release_json" ]]; then
  printf 'MISSING release=%s\n' "$tag" >&2
  failures=$((failures + 1))
else
  printf '%s\n' "$release_json"
  release_is_draft=$(gh release view "$tag" --repo "$repo" --json isDraft --jq .isDraft)
  if [[ "$release_is_draft" == true ]]; then
    printf 'INCOMPLETE release=%s state=draft\n' "$tag" >&2
    failures=$((failures + 1))
  fi
  expected_archive="FramekitFinalCutWorkflow-$version.zip"
  expected_checksum="$expected_archive.sha256"
  asset_names=$(gh release view "$tag" --repo "$repo" --json assets --jq '.assets[].name')
  if ! grep -Fxq "$expected_archive" <<<"$asset_names"; then
    printf 'MISSING asset=%s\n' "$expected_archive" >&2
    failures=$((failures + 1))
  fi
  if ! grep -Fxq "$expected_checksum" <<<"$asset_names"; then
    printf 'MISSING asset=%s\n' "$expected_checksum" >&2
    failures=$((failures + 1))
  fi
fi

printf '%s\n' '=== tag workflow runs ==='
workflow_json=$(gh run list --repo "$repo" --branch "$tag" --limit 30 \
  --json databaseId,workflowName,event,status,conclusion,headBranch,headSha,createdAt,url \
  2>/dev/null || printf '[]')
printf '%s\n' "$workflow_json"
successful_run_count=$(gh run list --repo "$repo" --branch "$tag" --limit 30 \
  --json status,conclusion,headBranch \
  --jq '[.[] | select(.status == "completed" and .conclusion == "success")] | length' \
  2>/dev/null || printf '0')
if [[ "$successful_run_count" == 0 ]]; then
  printf 'MISSING successful_tag_workflow=%s\n' "$tag" >&2
  failures=$((failures + 1))
fi

printf '%s\n' '=== npm registry ==='
published_version=$(npm view "$package@$version" version 2>/dev/null || true)
if [[ "$published_version" != "$version" ]]; then
  printf 'MISSING npm=%s@%s observed=%s\n' "$package" "$version" "${published_version:-none}" >&2
  failures=$((failures + 1))
else
  printf 'PASS npm=%s@%s\n' "$package" "$published_version"
fi

if ((failures)); then
  printf 'FAIL missing_surfaces=%s\n' "$failures" >&2
  exit 1
fi
printf 'PASS release=%s\n' "$version"
