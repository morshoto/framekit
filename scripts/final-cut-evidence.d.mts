export function sanitizeCanonicalEvidence(run: unknown, environment: {
  framekitVersion: string;
  finalCutVersion: string;
  gitCommit: string;
  nodeVersion: string;
  platform: string;
  architecture: string;
  osVersion: string;
}): unknown;
