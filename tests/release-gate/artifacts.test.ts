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
    reportFile: string;
    reportSha256: string;
    workflowCount: number;
  };

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.gate, report.gate);
  assert.equal(manifest.reportFile, "report.json");
  assert.equal(manifest.workflowCount, report.deterministic.workflows.length);
  assert.match(manifest.reportSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(await readFile(paths.reportPath, "utf8")), report);
  await assert.rejects(writeReleaseGateArtifacts(report, outputDirectory), /RELEASE_GATE_ARTIFACT_EXISTS/);
});
