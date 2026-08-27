export function sanitizeCanonicalEvidence(run: unknown, environment: {
  framekitVersion: string;
  finalCutVersion: string;
  gitCommit: string;
  nodeVersion: string;
  platform: string;
  architecture: string;
  osVersion: string;
}): unknown;

export function sanitizeDisposableNativeEvidence(run: unknown, environment: {
  framekitVersion: string;
  finalCutVersion: string;
  gitCommit: string;
  nodeVersion: string;
  platform: string;
  architecture: string;
  osVersion: string;
}): {
  evidenceType: string;
  mutation: { operation: string; status: string };
  restoration: { restored: boolean };
  toolResults: unknown[];
};
