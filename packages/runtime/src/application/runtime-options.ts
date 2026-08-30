import type {
  AudioAnalyzer,
  SpeechAnalyzer,
  VisualAnalyzer,
} from "../domain/media.js";
import type { VerificationEngine } from "../domain/verification.js";

export interface RuntimeOptions {
  speechAnalyzer?: SpeechAnalyzer;
  audioAnalyzer?: AudioAnalyzer;
  visualAnalyzer?: VisualAnalyzer;
  verificationEngine?: VerificationEngine;
  now?: () => number;
  previewTtlMs?: number;
  maxActivePreviews?: number;
}
