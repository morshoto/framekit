import { join, resolve } from "node:path";
import { renderReleaseGateReport, runReleaseGate } from "../tests/release-gate/runner.js";
import { writeReleaseGateArtifacts } from "../tests/release-gate/artifacts.js";
import { runRepositoryChecks } from "../tests/release-gate/repository-checks.js";
import { parseReleaseGateArgs } from "./run-release-gate-args.js";

const defaultRunId = `${new Date().toISOString().replace(/[^0-9]/g, "")}-${process.pid}`;
const defaultOutputDirectory = join(process.cwd(), "artifacts", "release-gate", defaultRunId);
const options = parseReleaseGateArgs(process.argv.slice(2), defaultOutputDirectory);
const repositoryChecks = await runRepositoryChecks({ rootDirectory: process.cwd() });
const report = await runReleaseGate({
  headedEvidenceDirectory: options.headedEvidenceDirectory,
  repositoryChecks,
});
const outputDirectory = options.outputDirectory;
const artifacts = await writeReleaseGateArtifacts(report, outputDirectory);

console.log(renderReleaseGateReport(report));
console.log(`output_directory=${resolve(artifacts.outputDirectory)}`);
console.log(`report=${resolve(artifacts.reportPath)}`);
console.log(`manifest=${resolve(artifacts.manifestPath)}`);

if (!report.deterministic.passed || !report.repositoryChecks.passed) process.exitCode = 1;
