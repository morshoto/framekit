import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ReleaseGateReport } from "./runner.js";

export interface ReleaseGateArtifactPaths {
  outputDirectory: string;
  reportPath: string;
  manifestPath: string;
}

export interface ReleaseGateArtifactManifest {
  schemaVersion: 1;
  gate: ReleaseGateReport["gate"];
  corpusVersion: string;
  generatedAt: string;
  reportFile: "report.json";
  reportSha256: string;
  workflowCount: number;
  deterministicPassed: boolean;
  liveStatus: ReleaseGateReport["live"]["status"];
}

export async function writeReleaseGateArtifacts(
  report: ReleaseGateReport,
  outputDirectory: string,
): Promise<ReleaseGateArtifactPaths> {
  await mkdir(dirname(outputDirectory), { recursive: true });
  try {
    await mkdir(outputDirectory);
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      throw new Error(`RELEASE_GATE_ARTIFACT_EXISTS: refusing to overwrite ${outputDirectory}`);
    }
    throw error;
  }

  const reportPath = join(outputDirectory, "report.json");
  const manifestPath = join(outputDirectory, "manifest.json");
  const reportBody = `${JSON.stringify(report, null, 2)}\n`;
  const manifest: ReleaseGateArtifactManifest = {
    schemaVersion: 1,
    gate: report.gate,
    corpusVersion: report.corpusVersion,
    generatedAt: report.generatedAt,
    reportFile: "report.json",
    reportSha256: sha256(reportBody),
    workflowCount: report.deterministic.workflows.length,
    deterministicPassed: report.deterministic.passed,
    liveStatus: report.live.status,
  };

  await writeFile(reportPath, reportBody, { encoding: "utf8", flag: "wx" });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return { outputDirectory, reportPath, manifestPath };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}
