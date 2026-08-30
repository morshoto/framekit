export function evidenceEnvironment(root: string): Promise<{
  framekitVersion: string;
  finalCutVersion: string;
  gitCommit: string;
  nodeVersion: string;
  platform: string;
  architecture: string;
  osVersion: string;
}>;

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

export function sanitizeCanonicalReadEvidence(run: unknown, environment: {
  framekitVersion: string;
  finalCutVersion: string;
  gitCommit: string;
  nodeVersion: string;
  platform: string;
  architecture: string;
  osVersion: string;
}): unknown;
