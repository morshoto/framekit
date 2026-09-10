import type { ContextRevision, RationalTime, TimeRange } from "./primitives.js";

import type { ProjectSnapshot, Clip } from "./project.js";

import type { ProjectSequence } from "./context.js";

export interface SpeechWord {
  text: string;
  start: number;
  end: number;
  confidence: number;
  filler?: boolean;
}

export type SpeechSegmentKind = "speech" | "silence" | "breath" | "laughter" | "noise";

export interface SpeechSegment {
  start: number;
  end: number;
  kind: SpeechSegmentKind;
  confidence?: number;
}

export const SPEECH_ANALYSIS_SCHEMA_VERSION = 1 as const;

export type SpeechAnalysisCapability = "transcription-only" | "transcription-plus-vad";

export interface SpeechAnalyzerCapabilities {
  transcription: boolean;
  vad: boolean;
}

export type MediaAnalysisCapability = "metadata" | "speech" | "audio" | "noise" | "visual";

export interface SemanticTag {
  value: string;
  confidence: number;
}

export interface MetadataAnalysis {
  subjects?: SemanticTag[];
  scenes?: SemanticTag[];
  environments?: SemanticTag[];
  timeOfDay?: SemanticTag[];
  moods?: SemanticTag[];
  usableRanges?: TimeRange[];
  confidence?: number;
}

export interface AnalyzerDescriptor {
  id: string;
  provider: string;
  version?: string;
}

export interface MediaSourceIdentity {
  mediaId: string;
  source: string;
  sourceDigest?: string;
  mediaKind?: "video" | "audio";
  duration?: number;
}

export function sameMediaSourceIdentity(left: MediaSourceIdentity, right: MediaSourceIdentity): boolean {
  return left.mediaId === right.mediaId
    && left.source === right.source
    && left.sourceDigest === right.sourceDigest
    && left.mediaKind === right.mediaKind
    && left.duration === right.duration;
}

export interface AnalysisProvenance {
  analyzer: AnalyzerDescriptor;
  source: MediaSourceIdentity;
  ranges: TimeRange[];
}

export interface MediaAnalysisStatus {
  capability: MediaAnalysisCapability;
  status: "analyzed" | "available" | "unavailable";
  provenance?: AnalysisProvenance;
  reason?: string;
}

export interface MediaSemanticDescription {
  subjects: SemanticTag[];
  scenes: SemanticTag[];
  environments: SemanticTag[];
  timeOfDay: SemanticTag[];
  moods: SemanticTag[];
  motion?: VisualMotion;
  usableRanges: TimeRange[];
  transcript?: string;
  audio?: {
    present: boolean;
    integratedLufs?: number;
    truePeakDb?: number;
    silenceMs?: number;
  };
}

export interface MediaIndexEntry {
  sourceIdentity: MediaSourceIdentity;
  semantic: MediaSemanticDescription;
  analysis: MediaAnalysisStatus[];
  analysisRevision?: string;
}

export interface MediaIndexQuery {
  query?: string;
  subject?: string;
  scene?: string;
  environment?: string;
  timeOfDay?: string;
  mood?: string;
  motion?: VisualMotion["label"];
  range?: TimeRange;
  capabilities?: MediaAnalysisCapability[];
}

export interface RoughCutPlanRequest extends MediaIndexQuery {
  maxShots?: number;
}

export interface RoughCutShot {
  order: number;
  sourceIdentity: MediaSourceIdentity;
  range: TimeRange;
  confidence: number;
  matchedProperties: string[];
  rationale: string;
}

export interface RoughCutPlan {
  planner: {
    id: string;
    version: number;
  };
  revision: ContextRevision;
  query: RoughCutPlanRequest;
  shots: RoughCutShot[];
  warnings: string[];
}

export interface SpeechAnalysis {
  /** Provenance fields are optional for backwards-compatible provider ports. */
  mediaId?: string;
  sourceIdentity?: MediaSourceIdentity;
  requestedRange?: TimeRange;
  observedRange?: TimeRange;
  revision?: ContextRevision;
  provider?: AnalyzerDescriptor;
  sourceTimebase?: RationalTime;
  capability?: SpeechAnalysisCapability;
  words: SpeechWord[];
  vadSegments?: SpeechSegment[];
  silenceSegments?: SpeechSegment[];
  protectedSegments?: SpeechSegment[];
}

/** Speech evidence that is safe to use for a specific editor revision. */
export interface RevisionBoundSpeechAnalysis extends SpeechAnalysis {
  mediaId: string;
  sourceIdentity: MediaSourceIdentity;
  requestedRange: TimeRange;
  observedRange: TimeRange;
  revision: ContextRevision;
  provider: AnalyzerDescriptor;
  sourceTimebase: RationalTime;
  capability: SpeechAnalysisCapability;
}

export interface AudioAnalysis {
  integratedLufs: number;
  truePeakDb: number;
  silenceMs: number;
  audibleSamples?: number;
  analyzedDurationSeconds?: number;
  dialoguePresent?: boolean;
  valid?: boolean;
  invalidReason?: string;
}

/** Provider output for locating and reducing unwanted background noise. */
export interface NoiseAnalysis {
  noiseFloorDb: number;
  peakNoiseDb?: number;
  affectedRanges: TimeRange[];
  recommendedReductionDb: number;
  confidence: number;
  valid?: boolean;
  invalidReason?: string;
}

/** Revision-bound noise evidence for one complete timeline occurrence. */
export interface NoiseMeasurement extends NoiseAnalysis {
  mediaId: string;
  occurrenceId: string;
  requestedRange: TimeRange;
  measuredRange: TimeRange;
  revision: ContextRevision;
  provider: AnalyzerDescriptor;
}

/** Revision-bound audio evidence for one complete timeline occurrence. */
export interface AudioMeasurement {
  mediaId: string;
  occurrenceId: string;
  requestedRange: TimeRange;
  measuredRange: TimeRange;
  revision: ContextRevision;
  provider: AnalyzerDescriptor;
  dialoguePresent: boolean;
  integratedLufs: number;
  truePeakDb: number;
  silenceMs: number;
  analyzedDurationSeconds: number;
  valid: boolean;
  invalidReason?: string;
}

export interface VisualScene {
  id: string;
  start: number;
  end: number;
  label?: string;
  confidence?: number;
}

export interface VisualSubject {
  id: string;
  label: string;
  confidence: number;
  start?: number;
  end?: number;
}

export interface VisualKeyframe {
  time: number;
  source: string;
  labels?: string[];
}

export interface VisualMotion {
  score: number;
  label?: "static" | "low" | "medium" | "high";
}

export interface VisualAnalysis {
  scenes: VisualScene[];
  subjects: VisualSubject[];
  motion?: VisualMotion;
  keyframes: VisualKeyframe[];
}

export interface FrameImage {
  /** Base64-encoded image bytes. */
  data: string;
  mimeType: string;
  width?: number;
  height?: number;
}

/** Editor-native frame data before runtime context is attached. */
export interface CapturedFrameSource {
  image: FrameImage;
  timecode: string;
}

export interface TimelineFrameCapture {
  image: FrameImage;
  position: RationalTime;
  timecode: string;
  project: ProjectSequence;
  sequence: ProjectSequence;
  clip?: Pick<Clip, "id" | "mediaId" | "name" | "startTime" | "durationTime" | "track">;
  analysis?: VisualAnalysis;
}

export interface MediaContext {
  mediaId: string;
  source: string;
  mediaKind?: "video" | "audio";
  duration?: number;
  sourceDigest?: string;
  metadata?: MetadataAnalysis;
  analysis?: MediaAnalysisStatus[];
  semantic?: MediaSemanticDescription;
  speech?: SpeechAnalysis;
  audio?: AudioAnalysis;
  noise?: NoiseAnalysis;
  visual?: VisualAnalysis;
  /** Revision of the source context used to produce attached analysis. */
  analysisRevision?: string;
}

export interface MediaUnderstanding {
  mediaId: string;
  source: string;
  sourceIdentity: MediaSourceIdentity;
  metadata?: MetadataAnalysis;
  speech?: SpeechAnalysis;
  audio?: AudioAnalysis;
  noise?: NoiseAnalysis;
  visual?: VisualAnalysis;
  semantic: MediaSemanticDescription;
  analysis: MediaAnalysisStatus[];
  analysisRevision: ContextRevision;
}

export interface AnalysisInput {
  project: ProjectSnapshot;
  media: MediaContext;
}

export interface SpeechAnalyzer {
  analyze(input: AnalysisInput, range?: TimeRange): Promise<SpeechAnalysis>;
  readonly descriptor?: AnalyzerDescriptor;
  readonly capabilities?: SpeechAnalyzerCapabilities;
}

export interface AudioAnalyzer {
  analyze(input: AnalysisInput, range?: TimeRange): Promise<AudioAnalysis>;
  readonly descriptor?: AnalyzerDescriptor;
}

export interface NoiseAnalyzer {
  analyze(input: AnalysisInput, range?: TimeRange): Promise<NoiseAnalysis>;
  readonly descriptor?: AnalyzerDescriptor;
}

export interface VisualAnalyzer {
  analyze(input: AnalysisInput, range?: TimeRange): Promise<VisualAnalysis>;
  readonly descriptor?: AnalyzerDescriptor;
}

export interface MetadataAnalyzer {
  analyze(input: AnalysisInput, range?: TimeRange): Promise<MetadataAnalysis>;
  readonly descriptor?: AnalyzerDescriptor;
}
