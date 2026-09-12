import {
  calculateActivityMetrics,
  calculateCoverageMetrics,
  calculateRoadmapProgress,
  type ActivityInput,
  type ActivityMetrics,
  type CoverageSummaryInput,
  type CoverageMetrics,
  type RoadmapProgress,
  isMilestoneRelease,
} from "./metrics.js";

export interface RoadmapSource {
  kind: "github-milestone";
  number: number;
  title: string;
  url: string;
}

export interface ReleaseReport {
  schemaVersion: 1;
  release: {
    baselineTag: string;
    currentTag: string;
  };
  quality: {
    coverage: CoverageMetrics;
  };
  product: {
    roadmap: RoadmapProgress & { source: RoadmapSource };
  };
  activity: ActivityMetrics;
}

export interface ReleaseReportInput {
  baselineTag: string;
  currentTag: string;
  coverage: {
    current: CoverageSummaryInput;
    baseline: CoverageSummaryInput;
  };
  roadmap: {
    completed: number;
    total: number;
    source: RoadmapSource;
  };
  activity: ActivityInput;
}

export function buildReleaseReport(input: ReleaseReportInput): ReleaseReport {
  if (!isMilestoneRelease(input.currentTag)) {
    throw new Error(`RELEASE_REPORT_MILESTONE_REQUIRED: ${input.currentTag}`);
  }
  if (input.baselineTag === input.currentTag) {
    throw new Error("RELEASE_REPORT_BASELINE_REQUIRED: baseline and current tags must differ");
  }

  return {
    schemaVersion: 1,
    release: {
      baselineTag: input.baselineTag,
      currentTag: input.currentTag,
    },
    quality: {
      coverage: calculateCoverageMetrics(input.coverage.current, input.coverage.baseline),
    },
    product: {
      roadmap: {
        ...calculateRoadmapProgress(input.roadmap),
        source: input.roadmap.source,
      },
    },
    activity: calculateActivityMetrics(input.activity),
  };
}

export function serializeReleaseReport(report: ReleaseReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderReleaseMarkdown(report: ReleaseReport): string {
  const { baselineTag, currentTag } = report.release;
  const { statements, functions } = report.quality.coverage;
  const { roadmap } = report.product;
  const { activity } = report;
  const roadmapPercentage = formatPercentage(roadmap.percentage);

  return [
    `# Framekit milestone report: ${currentTag}`,
    "",
    `Compared with baseline **${baselineTag}**. This report is generated from repository and public GitHub metadata; it does not infer progress from LOC or commit counts.`,
    "",
    "## Coverage",
    "",
    "| Metric | Current | Baseline | Delta |",
    "| --- | ---: | ---: | ---: |",
    `| Statements | ${formatPercentage(statements.current)} | ${formatPercentage(statements.baseline)} | ${formatDelta(statements.delta)} percentage points |`,
    `| Functions | ${formatPercentage(functions.current)} | ${formatPercentage(functions.baseline)} | ${formatDelta(functions.delta)} percentage points |`,
    "",
    "## Product progress",
    "",
    `- **Roadmap completion:** ${roadmap.completed} / ${roadmap.total} planned items (${roadmapPercentage}).`,
    `- **Source:** ${roadmap.source.kind} [${roadmap.source.title}](${roadmap.source.url}) (#${roadmap.source.number}).`,
    "",
    "## Community activity",
    "",
    `- ${activity.mergedPullRequests} merged PRs, ${activity.closedIssues} closed issues, ${activity.humanContributors} human contributors, and ${activity.botContributors} automated contributors excluded from the human count.`,
    "",
    "## Inputs",
    "",
    `- Baseline tag: \`${baselineTag}\``,
    `- Current tag: \`${currentTag}\``,
    `- Roadmap source: ${roadmap.source.url}`,
    "",
  ].join("\n");
}

export function renderCoverageChart(report: ReleaseReport): string {
  const { statements, functions } = report.quality.coverage;
  return svg(
    `Coverage: ${report.release.currentTag}`,
    [
      chartRow("Statements", statements.current, statements.baseline, statements.delta, 40),
      chartRow("Functions", functions.current, functions.baseline, functions.delta, 100),
    ].join("\n"),
  );
}

export function renderRoadmapChart(report: ReleaseReport): string {
  const { roadmap } = report.product;
  const percentage = formatPercentage(roadmap.percentage);
  const barWidth = roadmap.total === 0 ? 0 : Math.round(360 * roadmap.completed / roadmap.total);
  return svg(
    `Roadmap progress: ${report.release.currentTag}`,
    [
      `<text x="40" y="58" class="label">${escapeXml(roadmap.source.title)}</text>`,
      `<rect x="40" y="78" width="360" height="28" rx="14" fill="#e5e7eb"/>`,
      `<rect x="40" y="78" width="${barWidth}" height="28" rx="14" fill="#2563eb"/>`,
      `<text x="40" y="145" class="value">${roadmap.completed} / ${roadmap.total}</text>`,
      `<text x="40" y="174" class="detail">${percentage} complete</text>`,
    ].join("\n"),
  );
}

export function renderContributorsChart(report: ReleaseReport): string {
  const contributors = report.activity.contributors.slice(0, 10);
  const rows = contributors.length === 0
    ? [`<text x="40" y="80" class="detail">No human contributors</text>`]
    : contributors.flatMap((contributor, index) => {
      const y = 58 + index * 38;
      const barWidth = Math.min(360, contributor.mergedPullRequests * 48);
      return [
        `<text x="40" y="${y}" class="label">${escapeXml(contributor.login)}</text>`,
        `<rect x="160" y="${y - 16}" width="${barWidth}" height="20" rx="10" fill="#16a34a"/>`,
        `<text x="${Math.max(170, 168 + barWidth)}" y="${y}" class="detail">${contributor.mergedPullRequests} merged PRs</text>`,
      ];
    });
  return svg(`Human contributors: ${report.release.currentTag}`, rows.join("\n"));
}

function chartRow(label: string, current: number, baseline: number, delta: number, y: number): string {
  return [
    `<text x="40" y="${y}" class="label">${label}</text>`,
    `<rect x="160" y="${y - 16}" width="240" height="20" rx="10" fill="#e5e7eb"/>`,
    `<rect x="160" y="${y - 16}" width="${Math.round(240 * current / 100)}" height="20" rx="10" fill="#2563eb"/>`,
    `<text x="40" y="${y + 28}" class="detail">${formatPercentage(current)} current · ${formatPercentage(baseline)} baseline · ${formatDelta(delta, true)} pp</text>`,
  ].join("\n");
}

function svg(title: string, body: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 220" role="img" aria-labelledby="title">`,
    `<title id="title">${escapeXml(title)}</title>`,
    `<style>.label{font:600 16px sans-serif;fill:#111827}.value{font:700 28px sans-serif;fill:#111827}.detail{font:14px sans-serif;fill:#4b5563}</style>`,
    body,
    "</svg>",
    "",
  ].join("\n");
}

function formatPercentage(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(2).replace(/\.00$/, "")}%`;
}

function formatDelta(value: number, preservePrecision = false): string {
  const formatted = value.toFixed(2);
  return `${value >= 0 ? "+" : ""}${preservePrecision ? formatted : formatted.replace(/\.00$/, "")}`;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (character) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    "\"": "&quot;",
  })[character] ?? character);
}
