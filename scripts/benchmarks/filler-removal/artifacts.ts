import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  FillerRemovalBenchmarkReport,
  FillerRemovalSummary,
  FillerRemovalScenarioResult,
} from "./benchmark.js";

export interface FillerRemovalArtifactPaths {
  outputDirectory: string;
  resultsPath: string;
  manifestPath: string;
}

export interface FillerRemovalArtifactManifest {
  schemaVersion: number;
  benchmark: "filler-removal";
  metric: FillerRemovalBenchmarkReport["metric"];
  corpusVersion: string;
  corpusDigest: string;
  generatedAt: string;
  runtime: FillerRemovalBenchmarkReport["runtime"];
  configuration: FillerRemovalBenchmarkReport["configuration"];
  resultFile: string;
  resultCount: number;
  resultSha256: string;
  summary: FillerRemovalSummary;
}

export async function writeFillerRemovalArtifacts(
  report: FillerRemovalBenchmarkReport,
  outputDirectory: string,
): Promise<FillerRemovalArtifactPaths> {
  try {
    await mkdir(outputDirectory);
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      throw new Error(`FILLER_REMOVAL_ARTIFACT_EXISTS: refusing to overwrite ${outputDirectory}`);
    }
    throw error;
  }

  const resultsPath = join(outputDirectory, "results.jsonl");
  const manifestPath = join(outputDirectory, "manifest.json");
  const rawResults = report.scenarios.map((result) => JSON.stringify(result satisfies FillerRemovalScenarioResult)).join("\n") + "\n";
  const manifest: FillerRemovalArtifactManifest = {
    schemaVersion: report.schemaVersion,
    benchmark: "filler-removal",
    metric: report.metric,
    corpusVersion: report.corpusVersion,
    corpusDigest: report.corpusDigest,
    generatedAt: report.generatedAt,
    runtime: report.runtime,
    configuration: report.configuration,
    resultFile: "results.jsonl",
    resultCount: report.scenarios.length,
    resultSha256: sha256(rawResults),
    summary: report.summary,
  };

  await writeFile(resultsPath, rawResults, { encoding: "utf8", flag: "wx" });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return { outputDirectory, resultsPath, manifestPath };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}
