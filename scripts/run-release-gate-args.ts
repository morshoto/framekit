export function parseReleaseGateOutputDirectory(
  args: string[],
  defaultOutputDirectory: string,
): string {
  let outputDirectory: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = argument === "--output-dir"
      ? args[++index]
      : argument.startsWith("--output-dir=")
        ? argument.slice("--output-dir=".length)
        : undefined;
    if (value === undefined) throw new Error("USAGE: only --output-dir is supported");
    if (!value || value.startsWith("--")) throw new Error("USAGE: --output-dir requires a path");
    if (outputDirectory !== undefined) throw new Error("USAGE: specify --output-dir once");
    outputDirectory = value;
  }

  return outputDirectory ?? defaultOutputDirectory;
}
