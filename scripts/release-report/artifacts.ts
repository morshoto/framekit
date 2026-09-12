import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  renderContributorsChart,
  renderCoverageChart,
  renderReleaseMarkdown,
  renderRoadmapChart,
  serializeReleaseReport,
  type ReleaseReport,
} from "./report.js";

export interface ReleaseReportArtifactPaths {
  outputDirectory: string;
  reportJson: string;
  reportMarkdown: string;
  charts: {
    coverage: string;
    roadmapProgress: string;
    contributors: string;
  };
}

export async function writeReleaseReportArtifacts(
  report: ReleaseReport,
  outputDirectory: string,
): Promise<ReleaseReportArtifactPaths> {
  const chartsDirectory = join(outputDirectory, "charts");
  await mkdir(chartsDirectory, { recursive: true });

  const paths: ReleaseReportArtifactPaths = {
    outputDirectory,
    reportJson: join(outputDirectory, "report.json"),
    reportMarkdown: join(outputDirectory, "report.md"),
    charts: {
      coverage: join(chartsDirectory, "coverage.svg"),
      roadmapProgress: join(chartsDirectory, "roadmap-progress.svg"),
      contributors: join(chartsDirectory, "contributors.svg"),
    },
  };

  await Promise.all([
    writeFile(paths.reportJson, serializeReleaseReport(report), "utf8"),
    writeFile(paths.reportMarkdown, renderReleaseMarkdown(report), "utf8"),
    writeFile(paths.charts.coverage, renderCoverageChart(report), "utf8"),
    writeFile(paths.charts.roadmapProgress, renderRoadmapChart(report), "utf8"),
    writeFile(paths.charts.contributors, renderContributorsChart(report), "utf8"),
  ]);
  return paths;
}
