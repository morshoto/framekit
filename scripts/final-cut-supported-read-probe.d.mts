export type ProbeClassification = {
  evaluatedSurface: string;
  classification: "metadata-only" | "complete-direct-snapshot-candidate" | "unsupported/unknown";
  completeSnapshotCandidate: boolean;
  canonicalCapabilityPromoted: false;
  missingRequirements: string[];
  promotionRequirements: string[];
  reasons: string[];
};

export function parseAppleEventDictionary(xml: string): {
  suites: Array<{ name: string; code: string }>;
  accessGroups: Array<{ suite: string; suiteCode: string; identifier: string; access: string }>;
  commands: Array<{ suite: string; suiteCode: string; name: string; code: string }>;
  classes: Array<{ suite: string; suiteCode: string; name: string; code: string; properties: Array<{ name: string; code: string; type: string; access: string }>; elements: Array<{ type: string; code: string; access: string }> }>;
  recordTypes: Array<{ suite: string; suiteCode: string; name: string; code: string; properties: Array<{ name: string; code: string; type: string; access: string }> }>;
};
export function classifySupportedSurfaces(surfaces: Record<string, any>): ProbeClassification;
export function parseWorkflowSurface(header: string, extensionSource: string): Record<string, any>;
export function collectProbeReport(options?: {
  appPath?: string;
  commandRunner?: (command: string, args: string[]) => Promise<string>;
  hostHeader?: string;
  extensionSource?: string;
}): Promise<{
  probeVersion: number;
  finalCut: { bundleIdentifier: string | null; version: string | null; build: string | null; proExtensionHostVersion: string | null };
  supportedSurfaces: Record<string, any>;
  classification: ProbeClassification;
}>;
