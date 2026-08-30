#!/usr/bin/env python3
"""Apply pull-request labels from the title, branch name, and changed files."""

from __future__ import annotations

import json
import os
import re
import urllib.request
from collections.abc import Iterable
from typing import Any


RELEASE_CATEGORY_BY_TITLE_KIND = {
    "feat": "Release: Features",
    "feature": "Release: Features",
    "fix": "Release: Fixes",
    "bug": "Release: Fixes",
    "revert": "Release: Fixes",
    "refactor": "Release: Improvements",
    "improvement": "Release: Improvements",
    "style": "Release: Improvements",
    "perf": "Release: Performance",
    "docs": "Release: Documentation",
    "doc": "Release: Documentation",
    "test": "Release: Tests",
    "chore": "Release: Chores",
    "build": "Release: Chores",
    "ci": "Release: Chores",
    "design": "Release: Design",
}


def release_category_label(pull_request_title: str) -> str | None:
    """Return a release-note label for a conventional or legacy title prefix."""

    conventional_match = re.match(
        r"^\s*(?P<kind>feat|feature|fix|bug|revert|refactor|style|perf|docs|doc|test|chore|build|ci|design)"
        r"(?:\([^)]*\))?!?:",
        pull_request_title,
        re.IGNORECASE,
    )
    if conventional_match:
        return RELEASE_CATEGORY_BY_TITLE_KIND[conventional_match.group("kind").lower()]

    bracket_match = re.match(r"^\s*\[\s*(?P<kind>[^]]+?)\s*\]", pull_request_title)
    if bracket_match:
        kind = bracket_match.group("kind").strip().lower()
        return RELEASE_CATEGORY_BY_TITLE_KIND.get(kind)

    return None


def has_suffix(filename: str, suffixes: set[str]) -> bool:
    lower_name = filename.lower()
    return any(lower_name.endswith(suffix) for suffix in suffixes)


def labels_for_pull_request(
    head_ref: str,
    changed_files: Iterable[str],
    pull_request_title: str = "",
) -> set[str]:
    labels: set[str] = set()

    release_label = release_category_label(pull_request_title)
    if release_label:
        labels.add(release_label)

    if re.match(r"^(hotfix|fix)", head_ref):
        labels.add("Problem: Bug")
    if re.match(r"^feat", head_ref):
        labels.add("Type: New Feature")
    if re.match(r"^refactor", head_ref):
        labels.add("Type: Improvement")

    code_suffixes = {".py", ".js", ".rb", ".go", ".java", ".cpp"}
    database_suffixes = {".sql", ".db", ".db3", ".sqlite", ".sqlite3", ".psql"}
    machine_learning_suffixes = {".ipynb", ".r", ".jl", ".pt", ".onnx"}
    design_suffixes = {".sketch", ".fig", ".xd", ".ai", ".psd"}
    document_suffixes = {".md", ".rst", ".tex", ".pdf"}

    for filename in changed_files:
        if filename.startswith("frontend/"):
            labels.add("Group: Frontend")
        if filename.startswith("backend/"):
            labels.add("Group: Backend")
        if has_suffix(filename, database_suffixes):
            labels.add("Group: Database")
        if has_suffix(filename, machine_learning_suffixes):
            labels.add("Group: Machine Learning")
        if (
            filename.startswith("terraform/")
            or filename == "Dockerfile"
            or filename.startswith("docker/")
            or filename.startswith("k8s/")
            or filename.startswith("kubernetes/")
            or has_suffix(filename, {".tf", ".tfvars"})
        ):
            labels.add("Group: Infrastructure")
        if has_suffix(filename, design_suffixes):
            labels.add("Type: Design")
        if has_suffix(filename, document_suffixes):
            labels.add("Type: Document")
        if has_suffix(filename, code_suffixes):
            labels.add("Type: Improvement")
            labels.add("Priority: Mid")
        if has_suffix(filename, {".md", ".txt"}):
            labels.add("Feedback: Feature Request")

    return labels


def api_request(token: str, repository: str, path: str, *, method: str = "GET", body: dict[str, Any] | None = None) -> Any:
    request = urllib.request.Request(
        f"https://api.github.com{path}",
        method=method,
    )
    request.add_header("Authorization", f"Bearer {token}")
    request.add_header("Accept", "application/vnd.github+json")
    if body is not None:
        request.add_header("Content-Type", "application/json")
        request.data = json.dumps(body).encode("utf-8")
    with urllib.request.urlopen(request) as response:
        payload = response.read()
        return json.loads(payload) if payload else None


def changed_files_for_pull_request(token: str, repository: str, pr_number: str) -> list[str]:
    changed_files: list[str] = []
    page = 1
    while True:
        batch = api_request(token, repository, f"/repos/{repository}/pulls/{pr_number}/files?per_page=100&page={page}")
        if not batch:
            return changed_files
        changed_files.extend(item["filename"] for item in batch)
        page += 1


def main() -> None:
    token = os.environ["GITHUB_TOKEN"]
    repository = os.environ["REPOSITORY"]
    pr_number = os.environ["PR_NUMBER"]
    head_ref = os.environ["HEAD_REF"]
    pull_request_title = os.environ.get("PR_TITLE", "")
    changed_files = changed_files_for_pull_request(token, repository, pr_number)
    labels = labels_for_pull_request(head_ref, changed_files, pull_request_title)

    if not labels:
        print("No labels matched.")
        return

    api_request(
        token,
        repository,
        f"/repos/{repository}/issues/{pr_number}/labels",
        method="POST",
        body={"labels": sorted(labels)},
    )
    print("Applied labels:", ", ".join(sorted(labels)))


if __name__ == "__main__":
    main()
