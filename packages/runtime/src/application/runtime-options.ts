import type {
  AudioAnalyzer,
  NoiseAnalyzer,
  MetadataAnalyzer,
  SpeechAnalyzer,
  VisualAnalyzer,
} from "../domain/media.js";
import type { VerificationEngine } from "../domain/verification.js";

export interface RuntimeOptions {
  speechAnalyzer?: SpeechAnalyzer;
  audioAnalyzer?: AudioAnalyzer;
  noiseAnalyzer?: NoiseAnalyzer;
  visualAnalyzer?: VisualAnalyzer;
  metadataAnalyzer?: MetadataAnalyzer;
  verificationEngine?: VerificationEngine;
  now?: () => number;
  previewTtlMs?: number;
  maxActivePreviews?: number;
}
