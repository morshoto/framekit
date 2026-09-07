import type { EditTransaction } from "./editing.js";
import type { EditTarget } from "./editing.js";
import type { ColorCorrection } from "./project.js";

export interface AudioAudibilityAssertion {
  type: "audio-audibility";
  mediaId: string;
  minAudibleSamples?: number;
  maxSilenceMs?: number;
}

export interface AudioCoverageAssertion {
  type: "audio-coverage";
  mediaId: string;
  start: number;
  duration: number;
  toleranceSeconds?: number;
}

export interface AudioLoudnessAssertion {
  type: "audio-loudness";
  mediaId: string;
  targetLufs: number;
  toleranceDb?: number;
}

export interface AudioNoiseAssertion {
  type: "audio-noise";
  mediaId: string;
  maxNoiseFloorDb: number;
  minConfidence?: number;
}

export interface AudioSourceAssertion {
  type: "audio-source";
  mediaId: string;
  sourceDigest?: string;
  source?: string;
}

export interface VisualContentAssertion {
  type: "visual-content";
  mediaId: string;
  label: string;
  labelKind?: "scene" | "subject";
  minConfidence?: number;
}

export interface DurationAssertion {
  type: "duration";
  target: "timeline";
  expectedSeconds: number;
  toleranceSeconds?: number;
}

export interface StreamAssertion {
  type: "stream";
  target: "audio" | "video";
  expected: boolean;
}

export interface StructureAssertion {
  type: "structure";
  requirement: "media-present" | "occurrence-present" | "operation-present";
  mediaId?: string;
  occurrenceId?: string;
  operationType?: string;
}

export interface ColorCorrectionAssertion {
  type: "color-correction";
  clipId: string;
  expected: ColorCorrection;
}

export type VerificationAssertion =
  | AudioAudibilityAssertion
  | AudioCoverageAssertion
  | AudioLoudnessAssertion
  | AudioNoiseAssertion
  | AudioSourceAssertion
  | VisualContentAssertion
  | DurationAssertion
  | StreamAssertion
  | StructureAssertion
  | ColorCorrectionAssertion;

export interface VerificationPolicy {
  requireExpectedChange?: boolean;
  maxTruePeakDb?: number;
  requireSpeechContinuity?: boolean;
  targetLufs?: number;
  loudnessToleranceDb?: number;
  assertions?: VerificationAssertion[];
}

export type VerificationCheckStatus = "passed" | "failed" | "unavailable";

export interface VerificationCheck {
  name: string;
  passed: boolean;
  detail: string;
  status?: VerificationCheckStatus;
  expected?: unknown;
  observed?: unknown;
  reason?: string;
}

export interface VerificationReport {
  passed: boolean;
  checks: VerificationCheck[];
  target?: EditTarget;
}

export interface VerificationEngine {
  verify(transaction: EditTransaction, policy: VerificationPolicy): Promise<VerificationReport>;
}
