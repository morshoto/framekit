import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateReleaseReport } from "../../scripts/generate-release-report.js";

test("release report command regenerates all artifacts from explicit local inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framekit-release-report-cli-"));
  const currentCoveragePath = join(directory, "current.json");
  const baselineCoveragePath = join(directory, "baseline.json");
  const dataFilePath = join(directory, "github.json");
  const outputDirectory = join(directory, "artifacts");
  const coverage = (lines: number, functions: number) => ({
    total: {
      lines: { total: 10, covered: lines, skipped: 0, pct: lines * 10 },
      functions: { total: 4, covered: functions, skipped: 0, pct: functions * 25 },
    },
  });
  await writeFile(currentCoveragePath, JSON.stringify(coverage(8, 3)));
  await writeFile(baselineCoveragePath, JSON.stringify(coverage(7, 2)));
  await writeFile(dataFilePath, JSON.stringify({
    milestones: [{ number: 1, title: "Release for v0.2.0", html_url: "https://example/1", open_issues: 1, closed_issues: 2 }],
    activity: {
      baselineDate: "2026-01-01T00:00:00Z",
      currentDate: "2026-02-01T00:00:00Z",
      pullRequests: [],
      issues: [],
    },
  }));

  const paths = await generateReleaseReport({
    baselineTag: "v0.1.0",
    currentTag: "v0.2.0",
    baselineCoveragePath,
    currentCoveragePath,
    dataFilePath,
    outputDirectory,
  });

  const report = JSON.parse(await readFile(paths.reportJson, "utf8")) as {
    release: { baselineTag: string; currentTag: string };
    product: { roadmap: { completed: number; total: number } };
  };
  assert.deepEqual(report.release, { baselineTag: "v0.1.0", currentTag: "v0.2.0" });
  assert.deepEqual(report.product.roadmap, {
    completed: 2,
    total: 3,
    percentage: 66.67,
    source: { kind: "github-milestone", number: 1, title: "Release for v0.2.0", url: "https://example/1" },
  });
});
