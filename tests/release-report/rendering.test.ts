import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReleaseReport,
  renderContributorsChart,
  renderCoverageChart,
  renderReleaseMarkdown,
  renderRoadmapChart,
  serializeReleaseReport,
} from "../../scripts/release-report/report.js";

function report() {
  return buildReleaseReport({
    baselineTag: "v0.1.0",
    currentTag: "v0.2.0",
    coverage: {
      current: {
        lines: { total: 100, covered: 80, skipped: 0, pct: 80 },
        functions: { total: 20, covered: 15, skipped: 0, pct: 75 },
      },
      baseline: {
        lines: { total: 80, covered: 56, skipped: 0, pct: 70 },
        functions: { total: 10, covered: 6, skipped: 0, pct: 60 },
      },
    },
    roadmap: {
      completed: 18,
      total: 23,
      source: {
        kind: "github-milestone",
        number: 7,
        title: "Release for v0.2.0",
        url: "https://github.com/morshoto/framekit/milestone/7",
      },
    },
    activity: {
      pullRequests: [
        { number: 1, authorLogin: "alice", authorType: "User", merged: true },
        { number: 2, authorLogin: "alice", authorType: "User", merged: true },
      ],
      closedIssues: 4,
    },
  });
}

test("release report serializes stable machine-readable metrics", () => {
  const first = serializeReleaseReport(report());
  const second = serializeReleaseReport(report());

  assert.equal(first, second);
  assert.deepEqual(JSON.parse(first).release, {
    baselineTag: "v0.1.0",
    currentTag: "v0.2.0",
  });
  assert.equal(JSON.parse(first).quality.coverage.statements.delta, 10);
  assert.doesNotMatch(first, /\/Users\/|\/private\/|generatedAt/);
});

test("release Markdown summarizes auditable quality, product, and activity metrics", () => {
  const markdown = renderReleaseMarkdown(report());

  assert.match(markdown, /# Framekit milestone report: v0\.2\.0/);
  assert.match(markdown, /Coverage.*80%.*70%.*\+10 percentage points/s);
  assert.match(markdown, /18 \/ 23.*78\.26%/);
  assert.match(markdown, /2 merged PRs.*1 human contributors/);
  assert.match(markdown, /github-milestone/);
  assert.match(markdown, /https:\/\/github\.com\/morshoto\/framekit\/milestone\/7/);
});

test("charts are deterministic SVG projections of the report data", () => {
  const current = report();
  assert.match(renderCoverageChart(current), /^<svg[^>]+viewBox=/);
  assert.match(renderCoverageChart(current), /80%/);
  assert.match(renderCoverageChart(current), /\+10\.00 pp/);
  assert.match(renderRoadmapChart(current), /18 \/ 23/);
  assert.match(renderRoadmapChart(current), /78\.26%/);
  assert.match(renderContributorsChart(current), /alice/);
  assert.match(renderContributorsChart(current), /merged PRs/);
  for (const chart of [
    renderCoverageChart(current),
    renderRoadmapChart(current),
    renderContributorsChart(current),
  ]) {
    assert.match(chart, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.doesNotMatch(chart, /<script|onload=/i);
  }
});
