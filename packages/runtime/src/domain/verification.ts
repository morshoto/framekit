import type { EditTransaction } from "./editing.js";

export interface VerificationPolicy {
  requireExpectedChange?: boolean;
  maxTruePeakDb?: number;
  requireSpeechContinuity?: boolean;
  targetLufs?: number;
  loudnessToleranceDb?: number;
}

export interface VerificationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface VerificationReport {
  passed: boolean;
  checks: VerificationCheck[];
}

export interface VerificationEngine {
  verify(transaction: EditTransaction, policy: VerificationPolicy): Promise<VerificationReport>;
}
