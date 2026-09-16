import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  renderV0112AcceptanceReport,
  runV0112Acceptance,
} from "../tests/release-gate/v0112-acceptance.js";

const args = process.argv.slice(2);
const outputDirectory = resolve(readOption("--output-dir"));
const headedEvidenceDirectory = readOptionalOption("--headed-evidence-dir");
const report = await runV0112Acceptance({
  headedEvidenceDirectory: headedEvidenceDirectory ? resolve(headedEvidenceDirectory) : undefined,
});

await mkdir(dirname(outputDirectory), { recursive: true });
try {
  await mkdir(outputDirectory);
} catch (error) {
  if (isAlreadyExistsError(error)) throw new Error(`V0112_ACCEPTANCE_ARTIFACT_EXISTS: refusing to overwrite ${outputDirectory}`);
  throw error;
}
const reportPath = join(outputDirectory, "report.json");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

console.log(renderV0112AcceptanceReport(report));
console.log(`output_directory=${outputDirectory}`);
console.log(`report=${reportPath}`);
if (!report.deterministic.passed) process.exitCode = 1;

function readOption(name: string): string {
  const value = readOptionalOption(name);
  if (!value) throw new Error(`V0112_ACCEPTANCE_ARGUMENT_INVALID: ${name} is required`);
  return value;
}

function readOptionalOption(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--") || args.lastIndexOf(name) !== index) {
    throw new Error(`V0112_ACCEPTANCE_ARGUMENT_INVALID: ${name} requires one value and may appear once`);
  }
  return value;
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}
