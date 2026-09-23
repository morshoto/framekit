import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateActivityMetrics,
  calculateCoverageMetrics,
  calculateRoadmapProgress,
  isMilestoneRelease,
  selectPreviousMilestoneTag,
} from "../../scripts/release-report/metrics.js";

test("milestone releases are patch-zero tags only", () => {
  assert.equal(isMilestoneRelease("v0.2.0"), true);
  assert.equal(isMilestoneRelease("v1.0.0"), true);
  assert.equal(isMilestoneRelease("v0.2.1"), false);
  assert.equal(isMilestoneRelease("not-a-release"), false);
});

test("previous milestone selection is deterministic and excludes patch releases", () => {
  assert.equal(
    selectPreviousMilestoneTag("v0.2.0", ["v0.1.0", "v0.1.1", "v0.2.0", "v0.0.0"]),
    "v0.1.0",
  );
  assert.throws(
    () => selectPreviousMilestoneTag("v0.0.0", ["v0.0.0"]),
    /previous milestone tag/i,
  );
});

test("coverage metrics include current values and percentage-point deltas", () => {
  assert.deepEqual(
    calculateCoverageMetrics(
      {
        lines: { total: 100, covered: 80, skipped: 0, pct: 80 },
        functions: { total: 20, covered: 15, skipped: 0, pct: 75 },
      },
      {
        lines: { total: 80, covered: 56, skipped: 0, pct: 70 },
        functions: { total: 10, covered: 6, skipped: 0, pct: 60 },
      },
    ),
    {
      statements: { current: 80, baseline: 70, delta: 10 },
      functions: { current: 75, baseline: 60, delta: 15 },
    },
  );
});

test("roadmap progress reports completed, total, and meaningful percentage", () => {
  assert.deepEqual(calculateRoadmapProgress({ completed: 18, total: 23 }), {
    completed: 18,
    total: 23,
    percentage: 78.26,
  });
  assert.deepEqual(calculateRoadmapProgress({ completed: 0, total: 0 }), {
    completed: 0,
    total: 0,
    percentage: null,
  });
});

test("activity metrics exclude bot accounts from human contributor counts", () => {
  assert.deepEqual(
    calculateActivityMetrics({
      pullRequests: [
        { number: 1, authorLogin: "alice", authorType: "User", merged: true },
        { number: 2, authorLogin: "dependabot[bot]", authorType: "Bot", merged: true },
        { number: 3, authorLogin: "renovate[bot]", authorType: "User", merged: true },
        { number: 4, authorLogin: "alice", authorType: "User", merged: true },
      ],
      closedIssues: 3,
    }),
    {
      mergedPullRequests: 4,
      closedIssues: 3,
      humanContributors: 1,
      botContributors: 2,
      contributors: [{ login: "alice", mergedPullRequests: 2 }],
    },
  );
});
