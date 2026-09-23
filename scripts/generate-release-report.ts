import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseReleaseReportArgs, type ReleaseReportCliOptions } from "./release-report/args.js";
import { writeReleaseReportArtifacts, type ReleaseReportArtifactPaths } from "./release-report/artifacts.js";
import { fetchGitHubData, repositoryFromGitRemote } from "./release-report/github.js";
import { buildReportFromData, type ReleaseReportDataFile } from "./release-report/generator.js";

export async function generateReleaseReport(
  options: ReleaseReportCliOptions,
  cwd = process.cwd(),
): Promise<ReleaseReportArtifactPaths> {
  const currentCoverage = await readJson(resolve(cwd, options.currentCoveragePath));
  const baselineCoverage = await readJson(resolve(cwd, options.baselineCoveragePath));
  const data = options.dataFilePath
    ? await readJson(resolve(cwd, options.dataFilePath)) as ReleaseReportDataFile
    : await fetchGitHubData({
      repository: await repositoryFromGitRemote(cwd),
      baselineTag: options.baselineTag,
      currentTag: options.currentTag,
      cwd,
    });
  const report = buildReportFromData({
    baselineTag: options.baselineTag,
    currentTag: options.currentTag,
    currentCoverage,
    baselineCoverage,
    data,
  });
  return writeReleaseReportArtifacts(report, resolve(cwd, options.outputDirectory));
}

async function main(): Promise<void> {
  try {
    const options = parseReleaseReportArgs(
      process.argv.slice(2),
      join(process.cwd(), "artifacts", "release-report"),
    );
    const paths = await generateReleaseReport(options);
    console.log(`report=${paths.reportJson}`);
    console.log(`markdown=${paths.reportMarkdown}`);
    console.log(`charts=${Object.values(paths.charts).join(",")}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
