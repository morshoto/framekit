export interface ReleaseRunnerLabel {
  name?: unknown;
}

export interface ReleaseRunner {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  busy?: unknown;
  labels?: unknown;
}

export const REQUIRED_RELEASE_RUNNER_LABELS: readonly string[];

export function findAvailableReleaseRunner(
  runners: unknown,
): ReleaseRunner | undefined;

export function validateReleaseRunnerAvailability(
  runners: unknown,
): ReleaseRunner;
