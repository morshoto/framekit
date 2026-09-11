import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ReleaseGateEvidenceTiers, ReleaseGateReport } from "./runner.js";

export interface ReleaseGateArtifactPaths {
  outputDirectory: string;
  reportPath: string;
  manifestPath: string;
}

export interface ReleaseGateArtifactManifest {
  schemaVersion: 2;
  gate: ReleaseGateReport["gate"];
  manifestVersion: string;
  releaseVersion: ReleaseGateReport["releaseVersion"];
  corpusVersion: string;
  generatedAt: string;
  reportFile: "report.json";
  reportSha256: string;
  workflowCount: number;
  deterministicPassed: boolean;
  liveStatus: ReleaseGateReport["live"]["status"];
  evidenceTiers: {
    [K in keyof ReleaseGateEvidenceTiers]: {
      status: ReleaseGateEvidenceTiers[K]["status"];
      attempted: boolean;
      passed: boolean;
      mode: ReleaseGateEvidenceTiers[K]["mode"];
      backend: string;
      guarantee: string;
      workflowCount: number;
    };
  };
  workflowMatrix: ReleaseGateReport["workflowMatrix"];
  provenance: {
    releaseReady: boolean;
    checks: Array<{ name: string; status: string }>;
    summary: string;
  };
  repositoryChecks: {
    passed: boolean;
    checks: Array<{ name: string; status: string }>;
  };
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
    schemaVersion: 2,
    gate: report.gate,
    manifestVersion: report.manifestVersion,
    releaseVersion: report.releaseVersion,
    corpusVersion: report.corpusVersion,
    generatedAt: report.generatedAt,
    reportFile: "report.json",
    reportSha256: sha256(reportBody),
    workflowCount: report.deterministic.workflows.length,
    deterministicPassed: report.deterministic.passed,
    liveStatus: report.live.status,
    evidenceTiers: Object.fromEntries(
      Object.entries(report.evidenceTiers).map(([tier, evidence]) => [tier, {
        status: evidence.status,
        attempted: evidence.attempted,
        passed: evidence.passed,
        mode: evidence.mode,
        backend: evidence.backend,
        guarantee: evidence.guarantee,
        workflowCount: evidence.workflows.length,
      }]),
    ) as ReleaseGateArtifactManifest["evidenceTiers"],
    workflowMatrix: report.workflowMatrix,
    provenance: {
      releaseReady: report.provenance.releaseReady,
      checks: report.provenance.checks.map(({ name, status }) => ({ name, status })),
      summary: report.provenance.summary,
    },
    repositoryChecks: {
      passed: report.repositoryChecks.passed,
      checks: report.repositoryChecks.checks.map(({ name, status }) => ({ name, status })),
    },
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
