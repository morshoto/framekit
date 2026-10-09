import type {
  AudioAnalyzer,
  NoiseAnalyzer,
  MetadataAnalyzer,
  SpeechAnalyzer,
  VisualAnalyzer,
} from "../domain/media.js";
import type { VerificationEngine } from "../domain/verification.js";
import type { SemanticMediaIndexStore } from "./semantic-media-index-store.js";

export interface RuntimeOptions {
  speechAnalyzer?: SpeechAnalyzer;
  audioAnalyzer?: AudioAnalyzer;
  noiseAnalyzer?: NoiseAnalyzer;
  visualAnalyzer?: VisualAnalyzer;
  metadataAnalyzer?: MetadataAnalyzer;
  semanticMediaIndexStore?: SemanticMediaIndexStore;
  verificationEngine?: VerificationEngine;
  now?: () => number;
  previewTtlMs?: number;
  maxActivePreviews?: number;
}
