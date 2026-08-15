export interface ContextRevision {
  id: string;
  sequence: number;
  timestamp: string;
}

export interface Clip {
  id: string;
  mediaId?: string;
  name: string;
  start: number;
  duration: number;
  track: number;
  gainDb?: number;
  enabled?: boolean;
  startTime?: RationalTime;
  durationTime?: RationalTime;
}

export interface TimeRange {
  start: number;
  end: number;
}

export interface RationalTimeRange {
  start: RationalTime;
  duration: RationalTime;
}

/**
 * State that Final Cut can expose live through its Workflow Extension host.
 * This deliberately does not pretend to be a complete timeline snapshot.
 */
export interface FinalCutLiveState {
  project?: {
    id: string;
    name: string;
  };
  sequence?: {
    id: string;
    name: string;
    startTime: RationalTime;
    duration: RationalTime;
    frameDuration: RationalTime;
  };
  playheadTime?: RationalTime;
  sequenceTimeRange?: RationalTimeRange;
  revision: ContextRevision;
}

export type FinalCutLiveChangeKind =
  | "active-sequence-changed"
  | "playhead-changed"
  | "sequence-time-range-changed";

export interface FinalCutLiveChange {
  kind: FinalCutLiveChangeKind;
  revision: ContextRevision;
  state: FinalCutLiveState;
}

/** Exact interchange time; strings keep it JSON-safe at the MCP boundary. */
export interface RationalTime {
  value: string;
  timescale: string;
}

export interface Marker {
  id: string;
  start: number;
  duration: number;
  name: string;
}

export interface Caption {
  id: string;
  start: number;
  duration: number;
  text: string;
}

export interface SpeechWord {
  text: string;
  start: number;
  end: number;
  confidence: number;
  filler?: boolean;
}

export interface SpeechAnalysis {
  words: SpeechWord[];
}

export interface AudioAnalysis {
  integratedLufs: number;
  truePeakDb: number;
  silenceMs: number;
}

export interface MediaContext {
  mediaId: string;
  source: string;
  speech?: SpeechAnalysis;
  audio?: AudioAnalysis;
}

export interface ProjectSnapshot {
  projectId: string;
  projectName: string;
  timeline: {
    id: string;
    name: string;
    duration: number;
    clips: Clip[];
    markers: Marker[];
    captions: Caption[];
  };
  media: MediaContext[];
  revision: ContextRevision;
}

export type EditOperation =
  | {
      type: "rename-clip";
      clipId: string;
      name: string;
      baseRevision?: ContextRevision;
    }
  | {
      type: "trim-clip";
      clipId: string;
      duration: number;
      durationTime?: RationalTime;
      baseRevision?: ContextRevision;
    }
  | {
      type: "set-gain";
      clipId: string;
      gainDb: number;
      baseRevision?: ContextRevision;
    }
  | {
      type: "ripple-delete";
      timelineId: string;
      range: TimeRange;
      reason?: string;
      baseRevision?: ContextRevision;
    }
  | {
      type: "add-marker";
      timelineId: string;
      marker: Marker;
      baseRevision?: ContextRevision;
    };

export interface ClipChange {
  type: "ITEM_ADDED" | "ITEM_REMOVED" | "ITEM_MODIFIED";
  itemId: string;
  before?: Clip;
  after?: Clip;
}

export interface TimelineDiff {
  from: ContextRevision;
  to: ContextRevision;
  added: ClipChange[];
  removed: ClipChange[];
  modified: ClipChange[];
  durationDelta: number;
  markerChanges: Array<{ type: "MARKER_ADDED" | "MARKER_REMOVED"; marker: Marker }>;
  affectedRanges: TimeRange[];
}

export interface EditTransaction {
  id: string;
  operation: EditOperation;
  intent: string;
  planned: EditOperation[];
  applied: EditOperation[];
  baseRevision: ContextRevision;
  before: ProjectSnapshot;
  after: ProjectSnapshot;
  attemptedAfter: ProjectSnapshot;
  diff: TimelineDiff;
  verification?: VerificationReport;
  status: "APPLIED" | "VERIFIED" | "FAILED" | "ROLLED_BACK" | "ACCEPTED";
}

export interface EditorAdapter {
  read(): Promise<ProjectSnapshot>;
  apply(operation: EditOperation, expectedRevision: ContextRevision): Promise<void>;
}

export interface EditorIdentity {
  name: string;
  version: string;
  backend: string;
}

export interface EditorCapabilities {
  projectRead: boolean;
  timelineRead: boolean;
  timelineWrite: boolean;
  readAfterWrite: boolean;
  incrementalChanges: boolean;
  speechAnalysis: boolean;
  audioAnalysis: boolean;
  rollback: boolean;
  visualAnalysis: boolean;
  assetDiscovery: boolean;
  liveSelection?: boolean;
  livePlayhead?: boolean;
  playbackControl?: boolean;
}

export interface EditorPort extends EditorAdapter {
  getIdentity(): Promise<EditorIdentity>;
  getCapabilities(): Promise<EditorCapabilities>;
  readProject(): Promise<ProjectSnapshot>;
  restore(snapshot: ProjectSnapshot, expectedRevision: ContextRevision): Promise<void>;
  listAssets?(): Promise<EditorAsset[]>;
}

export interface FinalCutLivePort extends EditorPort {
  readLiveState(): Promise<FinalCutLiveState>;
  liveChangesSince(revision: ContextRevision, waitMs?: number): Promise<FinalCutLiveChange[]>;
}

export interface EditorAsset {
  id: string;
  kind: "transition" | "effect" | "title" | "generator" | "audio-effect" | "template";
  name: string;
  vendor: string;
  metadata: Record<string, unknown>;
}

export interface AnalysisInput {
  project: ProjectSnapshot;
  media: MediaContext;
}

export interface SpeechAnalyzer {
  analyze(input: AnalysisInput, range?: TimeRange): Promise<SpeechAnalysis>;
}

export interface AudioAnalyzer {
  analyze(input: AnalysisInput, range?: TimeRange): Promise<AudioAnalysis>;
}

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
