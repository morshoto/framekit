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

export type MediaAnalysisCapability = "metadata" | "speech" | "audio" | "visual";

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

export interface SpeechAnalysis {
  words: SpeechWord[];
}

export interface AudioAnalysis {
  integratedLufs: number;
  truePeakDb: number;
  silenceMs: number;
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
  speech?: SpeechAnalysis;
  audio?: AudioAnalysis;
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
  visual?: VisualAnalysis;
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
}

export interface AudioAnalyzer {
  analyze(input: AnalysisInput, range?: TimeRange): Promise<AudioAnalysis>;
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
