import type {
  ActivityInput,
  CoverageMetricInput,
  CoverageSummaryInput,
} from "./metrics.js";
import type { RoadmapSource } from "./report.js";

interface CoverageSummaryJson {
  total?: {
    lines?: unknown;
    statements?: unknown;
    functions?: unknown;
  };
}

export interface GitHubMilestoneRecord {
  number: number;
  title: string;
  html_url: string;
  open_issues: number;
  closed_issues: number;
}

export interface GitHubPullRequestRecord {
  number: number;
  user?: { login?: string; type?: string };
  merged_at?: string | null;
}

export interface GitHubIssueRecord {
  number: number;
  closed_at?: string | null;
  pull_request?: unknown;
}

export interface GitHubActivitySnapshot {
  baselineDate: string;
  currentDate: string;
  pullRequests: GitHubPullRequestRecord[];
  issues: GitHubIssueRecord[];
}

export function parseCoverageSummary(value: unknown, label: string): CoverageSummaryInput {
  const summary = value as CoverageSummaryJson | null;
  const lines = readCoverageMetric(summary?.total?.lines, label, "lines");
  const statements = summary?.total?.statements === undefined
    ? undefined
    : readCoverageMetric(summary.total.statements, label, "statements");
  const functions = readCoverageMetric(summary?.total?.functions, label, "functions");
  return { lines, ...(statements ? { statements } : {}), functions };
}

export function normalizeGitHubActivity(snapshot: GitHubActivitySnapshot): ActivityInput {
  const baseline = parseDate(snapshot.baselineDate, "baseline tag");
  const current = parseDate(snapshot.currentDate, "current tag");
  if (baseline >= current) {
    throw new Error("RELEASE_REPORT_ACTIVITY_WINDOW_INVALID: current must follow baseline");
  }

  const pullRequests = snapshot.pullRequests
    .filter((pullRequest) => isWithinWindow(pullRequest.merged_at, baseline, current))
    .map((pullRequest) => ({
      number: pullRequest.number,
      authorLogin: pullRequest.user?.login ?? "unknown",
      authorType: pullRequest.user?.type ?? "User",
      merged: true,
    }));
  const closedIssues = snapshot.issues.filter((issue) =>
    issue.pull_request === undefined
    && isWithinWindow(issue.closed_at, baseline, current),
  ).length;

  return { pullRequests, closedIssues };
}

export function selectGitHubMilestone(
  milestones: GitHubMilestoneRecord[],
  currentTag: string,
): RoadmapSource {
  const expectedTitle = `Release for ${currentTag}`;
  const milestone = milestones.find((candidate) => candidate.title === expectedTitle);
  if (!milestone) {
    throw new Error(`RELEASE_REPORT_MILESTONE_NOT_FOUND: ${expectedTitle}`);
  }
  return {
    kind: "github-milestone",
    number: milestone.number,
    title: milestone.title,
    url: milestone.html_url,
  };
}

function readCoverageMetric(value: unknown, label: string, metric: string): CoverageMetricInput {
  const candidate = value as Partial<CoverageMetricInput> | null;
  if (
    !candidate
    || !isFiniteNumber(candidate.total)
    || !isFiniteNumber(candidate.covered)
    || !isFiniteNumber(candidate.skipped)
    || !isFiniteNumber(candidate.pct)
  ) {
    throw new Error(`RELEASE_REPORT_${label.toUpperCase()}_COVERAGE_INVALID: missing ${metric} totals`);
  }
  return {
    total: candidate.total,
    covered: candidate.covered,
    skipped: candidate.skipped,
    pct: candidate.pct,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseDate(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`RELEASE_REPORT_DATE_INVALID: ${label}`);
  return parsed;
}

function isWithinWindow(value: string | null | undefined, baseline: number, current: number): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > baseline && parsed <= current;
}
