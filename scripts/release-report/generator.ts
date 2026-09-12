import {
  buildReleaseReport,
  type ReleaseReport,
} from "./report.js";
import {
  normalizeGitHubActivity,
  parseCoverageSummary,
  selectGitHubMilestone,
  type GitHubActivitySnapshot,
  type GitHubMilestoneRecord,
} from "./sources.js";

export interface ReleaseReportDataFile {
  milestones: GitHubMilestoneRecord[];
  activity: GitHubActivitySnapshot;
}

export interface BuildReportFromDataInput {
  baselineTag: string;
  currentTag: string;
  currentCoverage: unknown;
  baselineCoverage: unknown;
  data: ReleaseReportDataFile;
}

export function buildReportFromData(input: BuildReportFromDataInput): ReleaseReport {
  const milestone = input.data.milestones.find(
    (candidate) => candidate.title === `Release for ${input.currentTag}`,
  );
  const source = selectGitHubMilestone(input.data.milestones, input.currentTag);

  return buildReleaseReport({
    baselineTag: input.baselineTag,
    currentTag: input.currentTag,
    coverage: {
      current: parseCoverageSummary(input.currentCoverage, "current"),
      baseline: parseCoverageSummary(input.baselineCoverage, "baseline"),
    },
    roadmap: {
      completed: milestone?.closed_issues ?? 0,
      total: (milestone?.closed_issues ?? 0) + (milestone?.open_issues ?? 0),
      source,
    },
    activity: normalizeGitHubActivity(input.data.activity),
  });
}
