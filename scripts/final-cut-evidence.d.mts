export interface EvidenceEnvironment {
  framekitVersion: string;
  finalCutVersion: string;
  gitCommit: string;
  nodeVersion: string;
  platform: string;
  architecture: string;
  osVersion: string;
}

export function evidenceEnvironment(root: string): Promise<EvidenceEnvironment>;

export function sanitizeCanonicalEvidence(run: unknown, environment: EvidenceEnvironment): unknown;

export function sanitizeDisposableNativeEvidence(run: unknown, environment: EvidenceEnvironment): {
  evidenceType: string;
  mutation: { operation: string; status: string };
  restoration: { restored: boolean };
  toolResults: unknown[];
};

export function sanitizePictureInPictureEvidence(run: unknown, environment: EvidenceEnvironment): any;
export function sanitizeNativeTitleEvidence(run: unknown, environment: EvidenceEnvironment): any;
export function sanitizeMaskEvidence(run: unknown, environment: EvidenceEnvironment): any;
export function sanitizeFillerRemovalEvidence(run: unknown, environment: EvidenceEnvironment): any;
export function sanitizeCanonicalReadEvidence(run: unknown, environment: EvidenceEnvironment): unknown;
