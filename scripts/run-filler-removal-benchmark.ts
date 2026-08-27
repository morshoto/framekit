import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  renderFillerRemovalReport,
  runFillerRemovalBenchmark,
} from "../tests/filler-removal/benchmark.js";
import { writeFillerRemovalArtifacts } from "../tests/filler-removal/artifacts.js";

const outputDirectory = parseOutputDirectory(process.argv.slice(2));
const report = await runFillerRemovalBenchmark();
await mkdir(dirname(outputDirectory), { recursive: true });
const artifacts = await writeFillerRemovalArtifacts(report, outputDirectory);

console.log(renderFillerRemovalReport(report));
console.log(`output_directory=${resolve(artifacts.outputDirectory)}`);
console.log(`results=${resolve(artifacts.resultsPath)}`);
console.log(`manifest=${resolve(artifacts.manifestPath)}`);

if (!report.summary.threshold.passed) process.exitCode = 1;

function parseOutputDirectory(args: string[]): string {
  const optionIndex = args.indexOf("--output-dir");
  const inlineOption = args.find((arg) => arg.startsWith("--output-dir="));
  if (optionIndex >= 0) {
    const value = args[optionIndex + 1];
    if (!value || value.startsWith("--")) throw new Error("USAGE: --output-dir requires a path");
    if (inlineOption) throw new Error("USAGE: specify --output-dir once");
    return value;
  }
  if (inlineOption) {
    const value = inlineOption.slice("--output-dir=".length);
    if (!value) throw new Error("USAGE: --output-dir requires a path");
    return value;
  }
  if (args.length > 0) throw new Error("USAGE: only --output-dir is supported");
  const runId = `${new Date().toISOString().replace(/[^0-9]/g, "")}-${process.pid}`;
  return join(process.cwd(), "artifacts", "filler-removal", runId);
}
