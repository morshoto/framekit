import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeReleaseReportArtifacts } from "../../scripts/release-report/artifacts.js";
import { buildReleaseReport } from "../../scripts/release-report/report.js";

test("release report artifacts follow the attachment contract", async () => {
  const report = buildReleaseReport({
    baselineTag: "v0.1.0",
    currentTag: "v0.2.0",
    coverage: {
      current: {
        lines: { total: 10, covered: 8, skipped: 0, pct: 80 },
        functions: { total: 4, covered: 3, skipped: 0, pct: 75 },
      },
      baseline: {
        lines: { total: 10, covered: 7, skipped: 0, pct: 70 },
        functions: { total: 4, covered: 2, skipped: 0, pct: 50 },
      },
    },
    roadmap: {
      completed: 1,
      total: 2,
      source: { kind: "github-milestone", number: 1, title: "Release for v0.2.0", url: "https://example/1" },
    },
    activity: { pullRequests: [], closedIssues: 0 },
  });
  const directory = await mkdtemp(join(tmpdir(), "framekit-release-report-"));

  const paths = await writeReleaseReportArtifacts(report, directory);

  for (const path of [
    paths.reportJson,
    paths.reportMarkdown,
    paths.charts.coverage,
    paths.charts.roadmapProgress,
    paths.charts.contributors,
  ]) {
    await access(path);
  }
  assert.deepEqual(JSON.parse(await readFile(paths.reportJson, "utf8")), report);
  assert.match(await readFile(paths.reportMarkdown, "utf8"), /Framekit milestone report/);
  assert.match(await readFile(paths.charts.coverage, "utf8"), /<svg/);
});
