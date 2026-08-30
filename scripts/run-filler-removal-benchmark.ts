import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  renderFillerRemovalReport,
  runFillerRemovalBenchmark,
} from "../tests/filler-removal/benchmark.js";
import { writeFillerRemovalArtifacts } from "../tests/filler-removal/artifacts.js";
import { parseFillerRemovalOutputDirectory } from "./run-filler-removal-benchmark-args.js";

const defaultRunId = `${new Date().toISOString().replace(/[^0-9]/g, "")}-${process.pid}`;
const defaultOutputDirectory = join(process.cwd(), "artifacts", "filler-removal", defaultRunId);
const outputDirectory = parseFillerRemovalOutputDirectory(process.argv.slice(2), defaultOutputDirectory);
const report = await runFillerRemovalBenchmark();
await mkdir(dirname(outputDirectory), { recursive: true });
const artifacts = await writeFillerRemovalArtifacts(report, outputDirectory);

console.log(renderFillerRemovalReport(report));
console.log(`output_directory=${resolve(artifacts.outputDirectory)}`);
console.log(`results=${resolve(artifacts.resultsPath)}`);
console.log(`manifest=${resolve(artifacts.manifestPath)}`);

if (!report.summary.threshold.passed) process.exitCode = 1;
