import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ReleaseReportDataFile } from "./generator.js";
import type {
  GitHubActivitySnapshot,
  GitHubIssueRecord,
  GitHubMilestoneRecord,
  GitHubPullRequestRecord,
} from "./sources.js";

const execFileAsync = promisify(execFile);

export interface GitHubDataOptions {
  repository: string;
  baselineTag: string;
  currentTag: string;
  cwd?: string;
}

export function parseGitHubRepository(remote: string): string {
  const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote.trim());
  if (!match) throw new Error(`RELEASE_REPORT_GITHUB_REPOSITORY_INVALID: invalid GitHub repository remote ${remote}`);
  return match[1];
}

export function flattenGitHubPages<T>(value: unknown): T[] {
  if (!Array.isArray(value)) throw new Error("RELEASE_REPORT_GITHUB_RESPONSE_INVALID: expected an array");
  if (value.every((page) => Array.isArray(page))) return value.flat() as T[];
  return value as T[];
}

export async function fetchGitHubData(options: GitHubDataOptions): Promise<ReleaseReportDataFile> {
  const cwd = options.cwd ?? process.cwd();
  const [baselineDate, currentDate] = await Promise.all([
    gitDate(options.baselineTag, cwd),
    gitDate(options.currentTag, cwd),
  ]);
  const [milestones, pullRequests, issues] = await Promise.all([
    ghApi<GitHubMilestoneRecord>(`repos/${options.repository}/milestones?state=all&per_page=100`),
    ghApi<GitHubPullRequestRecord>(`repos/${options.repository}/pulls?state=closed&base=main&per_page=100`),
    ghApi<GitHubIssueRecord>(`repos/${options.repository}/issues?state=closed&since=${encodeURIComponent(baselineDate)}&per_page=100`),
  ]);

  const activity: GitHubActivitySnapshot = {
    baselineDate,
    currentDate,
    pullRequests,
    issues,
  };
  return { milestones, activity };
}

export async function repositoryFromGitRemote(cwd = process.cwd()): Promise<string> {
  const remote = await runCommand("git", ["config", "--get", "remote.origin.url"], cwd);
  return parseGitHubRepository(remote.trim());
}

async function ghApi<T>(endpoint: string): Promise<T[]> {
  const output = await runCommand("gh", ["api", "--paginate", "--slurp", endpoint], process.cwd());
  return flattenGitHubPages<T>(JSON.parse(output));
}

async function gitDate(tag: string, cwd: string): Promise<string> {
  return (await runCommand("git", ["show", "-s", "--format=%cI", tag], cwd)).trim();
}

async function runCommand(command: string, args: string[], cwd: string): Promise<string> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
    });
    return result.stdout;
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error
      ? String(error.stderr)
      : String(error);
    throw new Error(`RELEASE_REPORT_COMMAND_FAILED: ${command} ${args.join(" ")}\n${stderr.trim()}`);
  }
}
