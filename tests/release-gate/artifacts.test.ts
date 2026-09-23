import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runReleaseGate } from "./runner.js";
import { writeReleaseGateArtifacts } from "./artifacts.js";

test("release gate artifacts retain the report and an auditable manifest", async () => {
  const report = await runReleaseGate({ generatedAt: "2026-08-30T00:00:00.000Z" });
  const parent = await mkdtemp(join(tmpdir(), "framekit-release-gate-"));
  const outputDirectory = join(parent, "run");

  const paths = await writeReleaseGateArtifacts(report, outputDirectory);
  const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8")) as {
    schemaVersion: number;
    gate: string;
    manifestVersion: string;
    releaseVersion: string;
    reportFile: string;
    reportSha256: string;
    workflowCount: number;
    evidenceTiers: Record<string, { status: string; attempted: boolean; passed: boolean }>;
    workflowMatrix: Array<{ workflowId: string }>;
    provenance: { releaseReady: boolean; checks: Array<{ name: string; status: string }> };
    repositoryChecks: { passed: boolean; checks: Array<{ name: string; status: string }> };
  };

  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.gate, report.gate);
  assert.equal(manifest.manifestVersion, report.manifestVersion);
  assert.equal(manifest.releaseVersion, report.releaseVersion);
  assert.equal(manifest.reportFile, "report.json");
  assert.equal(manifest.workflowCount, report.deterministic.workflows.length);
  assert.match(manifest.reportSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(manifest.evidenceTiers), [
    "deterministic",
    "fcpxml-artifact",
    "metadata-only",
    "canonical-live",
    "headed-native",
  ]);
  assert.equal(manifest.evidenceTiers.deterministic.status, "verified");
  assert.equal(manifest.evidenceTiers["canonical-live"].status, "unsupported");
  assert.equal(manifest.evidenceTiers["headed-native"].status, "unrun");
  assert.deepEqual(manifest.workflowMatrix.map((workflow) => workflow.workflowId), report.workflowMatrix.map((workflow) => workflow.workflowId));
  assert.equal(manifest.provenance.releaseReady, report.provenance.releaseReady);
  assert.deepEqual(manifest.provenance.checks.map((check) => check.name), report.provenance.checks.map((check) => check.name));
  assert.equal(manifest.repositoryChecks.passed, report.repositoryChecks.passed);
  assert.deepEqual(manifest.repositoryChecks.checks.map((check) => check.status), report.repositoryChecks.checks.map((check) => check.status));
  assert.deepEqual(JSON.parse(await readFile(paths.reportPath, "utf8")), report);
  assert.doesNotMatch(await readFile(paths.reportPath, "utf8"), /\/private\/|\/Users\/|\/home\/|operationId|sourceIdentity/);
  await assert.rejects(writeReleaseGateArtifacts(report, outputDirectory), /RELEASE_GATE_ARTIFACT_EXISTS/);
});
