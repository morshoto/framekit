export const REQUIRED_RELEASE_RUNNER_LABELS = Object.freeze([
  "self-hosted",
  "macOS",
  "framekit-release",
]);

export function findAvailableReleaseRunner(runners) {
  if (!Array.isArray(runners)) {
    return undefined;
  }

  return runners.find((runner) => {
    if (runner?.status !== "online" || runner?.busy !== false) {
      return false;
    }

    return REQUIRED_RELEASE_RUNNER_LABELS.every((requiredLabel) => (
      Array.isArray(runner.labels)
      && runner.labels.some((label) => label?.name === requiredLabel)
    ));
  });
}

export function validateReleaseRunnerAvailability(runners) {
  const selected = findAvailableReleaseRunner(runners);
  if (!selected) {
    throw new Error(
      `RELEASE_RUNNER_UNAVAILABLE: no online and idle repository runner has labels `
      + `${REQUIRED_RELEASE_RUNNER_LABELS.join(", ")}. Register or start the repository runner before retrying the release.`,
    );
  }
  return selected;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function validateRunnerApiResponse() {
  const payload = JSON.parse(await readStdin());
  const runners = Array.isArray(payload) ? payload : payload?.runners;
  const selected = validateReleaseRunnerAvailability(runners);
  process.stdout.write(`Release runner available: ${selected.name ?? selected.id}\n`);
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  validateRunnerApiResponse().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
