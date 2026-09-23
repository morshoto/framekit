export interface ReleaseReportCliOptions {
  baselineTag: string;
  currentTag: string;
  baselineCoveragePath: string;
  currentCoveragePath: string;
  dataFilePath?: string;
  outputDirectory: string;
}

export function parseReleaseReportArgs(
  args: string[],
  defaultOutputDirectory: string,
): ReleaseReportCliOptions {
  let baselineTag: string | undefined;
  let currentTag: string | undefined;
  let baselineCoveragePath: string | undefined;
  let currentCoveragePath: string | undefined;
  let dataFilePath: string | undefined;
  let outputDirectory: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const option = optionName(argument);
    if (!option) throw usage("only named options are supported");
    const value = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : args[++index];
    if (!value || value.startsWith("--")) throw usage(`${option} requires a value`);

    switch (option) {
      case "--baseline-tag":
        baselineTag = assignOnce(option, baselineTag, value);
        break;
      case "--current-tag":
        currentTag = assignOnce(option, currentTag, value);
        break;
      case "--baseline-coverage":
        baselineCoveragePath = assignOnce(option, baselineCoveragePath, value);
        break;
      case "--current-coverage":
        currentCoveragePath = assignOnce(option, currentCoveragePath, value);
        break;
      case "--data-file":
        dataFilePath = assignOnce(option, dataFilePath, value);
        break;
      case "--output-dir":
        outputDirectory = assignOnce(option, outputDirectory, value);
        break;
      default:
        throw usage(`unsupported option ${option}`);
    }
  }

  if (!baselineTag || !currentTag || !baselineCoveragePath || !currentCoveragePath) {
    throw usage("baseline/current tags and coverage paths are required");
  }

  return {
    baselineTag,
    currentTag,
    baselineCoveragePath,
    currentCoveragePath,
    ...(dataFilePath ? { dataFilePath } : {}),
    outputDirectory: outputDirectory ?? defaultOutputDirectory,
  };
}

function optionName(argument: string | undefined): string | undefined {
  if (!argument) return undefined;
  const equalsIndex = argument.indexOf("=");
  return equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
}

function assignOnce(option: string, current: string | undefined, value: string): string {
  if (current !== undefined) throw usage(`specify ${option} once`);
  return value;
}

function usage(message: string): Error {
  return new Error(`USAGE: ${message}`);
}
