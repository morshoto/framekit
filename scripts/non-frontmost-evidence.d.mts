export type NonFrontmostEvidenceTier =
  | "deterministic"
  | "artifact"
  | "metadata-only"
  | "canonical-live"
  | "headed-native";

export const NON_FRONTMOST_EVIDENCE_TIERS: readonly NonFrontmostEvidenceTier[];

export interface NonFrontmostPreflight {
  mode: "fixture" | "fcpxml-artifact" | "metadata-only" | "canonical-live" | "native-write";
  documentMode: "fixture" | "fcpxml-artifact" | "metadata-only" | "canonical-live";
  processMode: "headless" | "headed";
  backend: string;
}

export interface NonFrontmostEvidence {
  evidenceTier: NonFrontmostEvidenceTier;
  provider: string;
  documentMode: NonFrontmostPreflight["documentMode"];
  processMode: NonFrontmostPreflight["processMode"];
}

export function evidenceFromPreflight(preflight: NonFrontmostPreflight): NonFrontmostEvidence;
