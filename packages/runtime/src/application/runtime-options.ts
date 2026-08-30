import type {
  AudioAnalyzer,
  MetadataAnalyzer,
  SpeechAnalyzer,
  VisualAnalyzer,
} from "../domain/media.js";
import type { VerificationEngine } from "../domain/verification.js";

export interface RuntimeOptions {
  speechAnalyzer?: SpeechAnalyzer;
  audioAnalyzer?: AudioAnalyzer;
  visualAnalyzer?: VisualAnalyzer;
  metadataAnalyzer?: MetadataAnalyzer;
  verificationEngine?: VerificationEngine;
  now?: () => number;
  previewTtlMs?: number;
  maxActivePreviews?: number;
}
