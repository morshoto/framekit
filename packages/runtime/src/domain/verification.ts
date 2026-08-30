import type { EditTransaction } from "./editing.js";

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

export interface AudioSourceAssertion {
  type: "audio-source";
  mediaId: string;
  sourceDigest?: string;
  source?: string;
}

export type VerificationAssertion =
  | AudioAudibilityAssertion
  | AudioCoverageAssertion
  | AudioLoudnessAssertion
  | AudioSourceAssertion;

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
}

export interface VerificationEngine {
  verify(transaction: EditTransaction, policy: VerificationPolicy): Promise<VerificationReport>;
}
