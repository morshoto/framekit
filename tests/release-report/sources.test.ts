import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeGitHubActivity,
  parseCoverageSummary,
  selectGitHubMilestone,
} from "../../scripts/release-report/sources.js";

test("coverage source accepts c8 JSON summary totals", () => {
  assert.deepEqual(
    parseCoverageSummary({
      total: {
        lines: { total: 100, covered: 80, skipped: 0, pct: 80 },
        functions: { total: 20, covered: 15, skipped: 0, pct: 75 },
      },
    }, "current"),
    {
      lines: { total: 100, covered: 80, skipped: 0, pct: 80 },
      functions: { total: 20, covered: 15, skipped: 0, pct: 75 },
    },
  );
  assert.throws(
    () => parseCoverageSummary({ total: { lines: {} } }, "baseline"),
    /baseline.*coverage/i,
  );
});

test("GitHub activity is restricted to the exact milestone tag window", () => {
  assert.deepEqual(
    normalizeGitHubActivity({
      baselineDate: "2026-01-01T00:00:00Z",
      currentDate: "2026-02-01T00:00:00Z",
      pullRequests: [
        { number: 1, user: { login: "alice", type: "User" }, merged_at: "2026-01-15T00:00:00Z" },
        { number: 2, user: { login: "bob", type: "User" }, merged_at: "2026-02-02T00:00:00Z" },
        { number: 3, user: { login: "bot[bot]", type: "Bot" }, merged_at: "2026-01-20T00:00:00Z" },
      ],
      issues: [
        { number: 4, closed_at: "2026-01-20T00:00:00Z" },
        { number: 5, closed_at: "2026-01-20T00:00:00Z", pull_request: {} },
        { number: 6, closed_at: "2026-02-03T00:00:00Z" },
      ],
    }),
    {
      pullRequests: [
        { number: 1, authorLogin: "alice", authorType: "User", merged: true },
        { number: 3, authorLogin: "bot[bot]", authorType: "Bot", merged: true },
      ],
      closedIssues: 1,
    },
  );
});

test("GitHub milestone selection uses an explicit release title", () => {
  assert.deepEqual(
    selectGitHubMilestone([
      { number: 1, title: "Release for v0.1.0", html_url: "https://example/1", open_issues: 2, closed_issues: 3 },
      { number: 2, title: "Release for v0.2.0", html_url: "https://example/2", open_issues: 5, closed_issues: 18 },
    ], "v0.2.0"),
    {
      kind: "github-milestone",
      number: 2,
      title: "Release for v0.2.0",
      url: "https://example/2",
    },
  );
  assert.throws(
    () => selectGitHubMilestone([], "v0.2.0"),
    /milestone.*v0\.2\.0/i,
  );
});
