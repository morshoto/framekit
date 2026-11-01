export interface ReleaseGateCliOptions {
  outputDirectory: string;
  headedEvidenceDirectory?: string;
}

export function parseReleaseGateArgs(
  args: string[],
  defaultOutputDirectory: string,
): ReleaseGateCliOptions {
  let outputDirectory: string | undefined;
  let headedEvidenceDirectory: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const isOutputOption = argument === "--output-dir" || argument.startsWith("--output-dir=");
    const isHeadedOption = argument === "--headed-evidence-dir" || argument.startsWith("--headed-evidence-dir=");
    const outputValue = isOutputOption
      ? argument === "--output-dir" ? args[++index] : argument.slice("--output-dir=".length)
      : undefined;
    const headedValue = isHeadedOption
      ? argument === "--headed-evidence-dir" ? args[++index] : argument.slice("--headed-evidence-dir=".length)
      : undefined;

    if (isOutputOption) {
      if (!outputValue || outputValue.startsWith("--")) throw new Error("USAGE: --output-dir requires a path");
      if (outputDirectory !== undefined) throw new Error("USAGE: specify --output-dir once");
      outputDirectory = outputValue;
      continue;
    }
    if (isHeadedOption) {
      if (!headedValue || headedValue.startsWith("--")) throw new Error("USAGE: --headed-evidence-dir requires a path");
      if (headedEvidenceDirectory !== undefined) throw new Error("USAGE: specify --headed-evidence-dir once");
      headedEvidenceDirectory = headedValue;
      continue;
    }
    throw new Error("USAGE: only --output-dir and --headed-evidence-dir are supported");
  }

  return {
    outputDirectory: outputDirectory ?? defaultOutputDirectory,
    ...(headedEvidenceDirectory ? { headedEvidenceDirectory } : {}),
  };
}

export function parseReleaseGateOutputDirectory(
  args: string[],
  defaultOutputDirectory: string,
): string {
  return parseReleaseGateArgs(args, defaultOutputDirectory).outputDirectory;
}
