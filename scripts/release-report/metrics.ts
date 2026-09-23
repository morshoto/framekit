export interface CoverageMetricInput {
  total: number;
  covered: number;
  skipped: number;
  pct: number;
}

export interface CoverageSummaryInput {
  lines?: CoverageMetricInput;
  statements?: CoverageMetricInput;
  functions: CoverageMetricInput;
}

export interface CoverageMetric {
  current: number;
  baseline: number;
  delta: number;
}

export interface CoverageMetrics {
  statements: CoverageMetric;
  functions: CoverageMetric;
}

export interface RoadmapProgress {
  completed: number;
  total: number;
  percentage: number | null;
}

export interface PullRequestActivity {
  number: number;
  authorLogin: string;
  authorType: string;
  merged: boolean;
}

export interface ActivityInput {
  pullRequests: PullRequestActivity[];
  closedIssues: number;
}

export interface ContributorActivity {
  login: string;
  mergedPullRequests: number;
}

export interface ActivityMetrics {
  mergedPullRequests: number;
  closedIssues: number;
  humanContributors: number;
  botContributors: number;
  contributors: ContributorActivity[];
}

interface ReleaseVersion {
  tag: string;
  major: number;
  minor: number;
  patch: number;
}

export function isMilestoneRelease(tag: string): boolean {
  const version = parseReleaseVersion(tag);
  return version?.patch === 0;
}

export function selectPreviousMilestoneTag(currentTag: string, tags: string[]): string {
  const current = parseReleaseVersion(currentTag);
  if (!current || current.patch !== 0) {
    throw new Error(`RELEASE_REPORT_MILESTONE_REQUIRED: ${currentTag}`);
  }

  const previous = tags
    .map(parseReleaseVersion)
    .filter((version): version is ReleaseVersion => version !== undefined)
    .filter((version) => version.patch === 0 && compareVersions(version, current) < 0)
    .sort(compareVersions)
    .at(-1);

  if (!previous) {
    throw new Error(`RELEASE_REPORT_PREVIOUS_MILESTONE_TAG_REQUIRED: previous milestone tag required for ${currentTag}`);
  }
  return previous.tag;
}

export function calculateCoverageMetrics(
  current: CoverageSummaryInput,
  baseline: CoverageSummaryInput,
): CoverageMetrics {
  const currentStatements = current.statements ?? current.lines;
  const baselineStatements = baseline.statements ?? baseline.lines;
  if (!currentStatements || !baselineStatements) {
    throw new Error("RELEASE_REPORT_COVERAGE_MISSING: statements or lines coverage is required");
  }

  return {
    statements: percentageDelta(currentStatements.pct, baselineStatements.pct),
    functions: percentageDelta(current.functions.pct, baseline.functions.pct),
  };
}

export function calculateRoadmapProgress(input: {
  completed: number;
  total: number;
}): RoadmapProgress {
  if (!Number.isInteger(input.completed) || input.completed < 0) {
    throw new Error("RELEASE_REPORT_ROADMAP_INVALID: completed must be a non-negative integer");
  }
  if (!Number.isInteger(input.total) || input.total < input.completed) {
    throw new Error("RELEASE_REPORT_ROADMAP_INVALID: total must contain completed items");
  }

  return {
    completed: input.completed,
    total: input.total,
    percentage: input.total === 0 ? null : round(input.completed / input.total * 100),
  };
}

export function calculateActivityMetrics(input: ActivityInput): ActivityMetrics {
  const humanContributors = new Map<string, number>();
  const botContributors = new Set<string>();
  const mergedPullRequests = input.pullRequests.filter((pullRequest) => pullRequest.merged);

  for (const pullRequest of mergedPullRequests) {
    if (isBotAccount(pullRequest.authorLogin, pullRequest.authorType)) {
      botContributors.add(pullRequest.authorLogin);
      continue;
    }
    humanContributors.set(
      pullRequest.authorLogin,
      (humanContributors.get(pullRequest.authorLogin) ?? 0) + 1,
    );
  }

  return {
    mergedPullRequests: mergedPullRequests.length,
    closedIssues: input.closedIssues,
    humanContributors: humanContributors.size,
    botContributors: botContributors.size,
    contributors: [...humanContributors.entries()]
      .map(([login, mergedPullRequests]) => ({ login, mergedPullRequests }))
      .sort((left, right) => left.login.localeCompare(right.login)),
  };
}

function parseReleaseVersion(tag: string): ReleaseVersion | undefined {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!match) return undefined;
  return {
    tag,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersions(left: ReleaseVersion, right: ReleaseVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function percentageDelta(current: number, baseline: number): CoverageMetric {
  return {
    current: round(current),
    baseline: round(baseline),
    delta: round(current - baseline),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function isBotAccount(login: string, type: string): boolean {
  return type.toLowerCase() === "bot" || login.toLowerCase().endsWith("[bot]");
}
