import assert from "node:assert/strict";
import test from "node:test";
import { buildReportFromData } from "../../scripts/release-report/generator.js";

test("generator combines coverage, milestone, and activity snapshots", () => {
  const report = buildReportFromData({
    baselineTag: "v0.1.0",
    currentTag: "v0.2.0",
    currentCoverage: {
      total: {
        lines: { total: 100, covered: 80, skipped: 0, pct: 80 },
        functions: { total: 20, covered: 15, skipped: 0, pct: 75 },
      },
    },
    baselineCoverage: {
      total: {
        lines: { total: 80, covered: 56, skipped: 0, pct: 70 },
        functions: { total: 10, covered: 6, skipped: 0, pct: 60 },
      },
    },
    data: {
      milestones: [
        { number: 7, title: "Release for v0.2.0", html_url: "https://example/7", open_issues: 5, closed_issues: 18 },
      ],
      activity: {
        baselineDate: "2026-01-01T00:00:00Z",
        currentDate: "2026-02-01T00:00:00Z",
        pullRequests: [
          { number: 10, user: { login: "alice", type: "User" }, merged_at: "2026-01-15T00:00:00Z" },
        ],
        issues: [{ number: 11, closed_at: "2026-01-20T00:00:00Z" }],
      },
    },
  });

  assert.equal(report.product.roadmap.completed, 18);
  assert.equal(report.product.roadmap.total, 23);
  assert.equal(report.activity.mergedPullRequests, 1);
  assert.equal(report.activity.closedIssues, 1);
  assert.equal(report.quality.coverage.statements.delta, 10);
});
