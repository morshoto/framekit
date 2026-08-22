export interface ContextRevision {
  id: string;
  sequence: number;
  timestamp: string;
}

export interface Clip {
  /** Stable identity of this timeline occurrence, never the media resource id. */
  id: string;
  mediaId?: string;
  name: string;
  start: number;
  duration: number;
  track: number;
  gainDb?: number;
  enabled?: boolean;
  /** Authoritative exact timeline coordinates; start/duration are convenience seconds. */
  startTime: RationalTime;
  durationTime: RationalTime;
}

export interface TimeRange {
  start: number;
  end: number;
  /** Exact representation used when the range crossed an editor boundary. */
  startTime?: RationalTime;
  durationTime?: RationalTime;
}

export interface RationalTimeRange {
  start: RationalTime;
  duration: RationalTime;
}

/**
 * State that Final Cut can expose live through its Workflow Extension host.
 * This deliberately does not pretend to be a complete timeline snapshot.
 */
export interface EditorLiveState {
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

/** Stable project and sequence identities exposed by an editor backend. */
export interface ProjectSequence {
  id: string;
  name: string;
}

export interface ProjectDescriptor {
  id: string;
  name: string;
  sequences: ProjectSequence[];
}

export interface ProjectCatalog {
  projects: ProjectDescriptor[];
  activeProjectId?: string;
  activeSequenceId?: string;
}

export interface ProjectSelection {
  projectId: string;
  sequenceId?: string;
}

export type EditorChangeKind =
  | "active-sequence-changed"
  | "playhead-changed"
  | "sequence-time-range-changed";

export interface EditorChange {
  kind: EditorChangeKind;
  revision: ContextRevision;
  state: EditorLiveState;
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
  startTime?: RationalTime;
  durationTime?: RationalTime;
}

export interface Caption {
  id: string;
  start: number;
  duration: number;
  text: string;
  startTime?: RationalTime;
  durationTime?: RationalTime;
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

export interface MediaContext {
  mediaId: string;
  source: string;
  speech?: SpeechAnalysis;
  audio?: AudioAnalysis;
  visual?: VisualAnalysis;
  /** Revision of the source context used to produce attached analysis. */
  analysisRevision?: string;
}

export interface MediaUnderstanding {
  mediaId: string;
  source: string;
  speech?: SpeechAnalysis;
  audio?: AudioAnalysis;
  visual?: VisualAnalysis;
  analysisRevision: ContextRevision;
}

export interface ProjectSnapshot {
  projectId: string;
  projectName: string;
  timeline: {
    id: string;
    name: string;
    duration: number;
    durationTime?: RationalTime;
    clips: Clip[];
    storyElements: StoryElement[];
    markers: Marker[];
    captions: Caption[];
  };
  media: MediaContext[];
  revision: ContextRevision;
}

/** Ordered FCPXML story elements retained so heterogeneous spines are not lost. */
export interface StoryElement {
  id: string;
  kind: string;
  start: number;
  duration: number;
  startTime?: RationalTime;
  durationTime?: RationalTime;
  lane?: number;
  mediaId?: string;
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
  durationDeltaTime?: RationalTime;
  markerChanges: Array<{
    type: "MARKER_ADDED" | "MARKER_REMOVED" | "MARKER_MODIFIED";
    marker: Marker;
    before?: Marker;
    after?: Marker;
  }>;
  captionChanges: Array<{
    type: "CAPTION_ADDED" | "CAPTION_REMOVED" | "CAPTION_MODIFIED";
    caption: Caption;
    before?: Caption;
    after?: Caption;
  }>;
  storyElementChanges: Array<{
    type: "STORY_ELEMENT_ADDED" | "STORY_ELEMENT_REMOVED" | "STORY_ELEMENT_MODIFIED";
    element: StoryElement;
    before?: StoryElement;
    after?: StoryElement;
  }>;
  affectedRanges: TimeRange[];
}

export interface AssetChange {
  type: "ASSET_ADDED" | "ASSET_REMOVED" | "ASSET_MODIFIED";
  assetId: string;
  before?: EditorAsset;
  after?: EditorAsset;
}

export interface ContextChangeSet {
  from: ContextRevision;
  to: ContextRevision;
  timeline?: TimelineDiff;
  stateChanges: EditorChange[];
  assetChanges: AssetChange[];
}

export interface ContextDiff {
  from: ContextRevision;
  to: ContextRevision;
  timeline?: TimelineDiff;
  stateChanges: EditorChange[];
  assetChanges: AssetChange[];
}

export interface AgentContext {
  revision: ContextRevision;
  project: ProjectSnapshot;
  editorState?: EditorLiveState;
  media: MediaContext[];
  recentChanges: ContextDiff;
  capabilities: RuntimeCapabilities;
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
  /** Apply atomically and return the resulting revision for read-failure rollback. */
  apply(operation: EditOperation, expectedRevision: ContextRevision): Promise<ContextRevision>;
}

export interface EditorIdentity {
  name: string;
  version: string;
  backend: string;
}

export interface EditorCapabilities {
  /** Derived canonical guarantee exposed to agents; omitted only by legacy adapters. */
  canonicalTimelineMode?: "metadata-only" | "canonical-read" | "canonical-write";
  projectRead: boolean;
  timelineSnapshotRead: boolean;
  timelineWrite: boolean;
  timelineArtifactWrite: boolean;
  readAfterWrite: boolean;
  incrementalChanges: boolean;
  rollback: boolean;
  assetDiscovery: boolean;
  liveStateRead: boolean;
  playheadWrite: boolean;
  playbackControl?: boolean;
  /** Canonical artifact can be imported as a new editor project. */
  timelinePublishNewProject?: boolean;
  /** The backend can enumerate stable project and sequence identities. */
  projectCatalogRead?: boolean;
  /** The backend can select a project and, when needed, one of its sequences. */
  projectSelection?: boolean;
}

export interface AnalyzerCapabilities {
  speechTranscribe: boolean;
  speechVad: boolean;
  audioLoudness: boolean;
  visualTrack: boolean;
}

export interface RuntimeCapabilities {
  editor: EditorCapabilities;
  analyzers: AnalyzerCapabilities;
}

export interface EditorPort extends EditorAdapter {
  getIdentity(): Promise<EditorIdentity>;
  getCapabilities(): Promise<RuntimeCapabilities>;
  readProject(): Promise<ProjectSnapshot>;
  restore(snapshot: ProjectSnapshot, expectedRevision: ContextRevision): Promise<void>;
  listAssets?(query?: AssetSearchQuery): Promise<EditorAsset[]>;
  /** Optional native change feed; absence falls back to a snapshot diff. */
  readChanges?(since: ContextRevision): Promise<ContextChangeSet>;
  listProjects?(): Promise<ProjectCatalog>;
  selectProject?(selection: ProjectSelection): Promise<ProjectCatalog>;
}

export interface LiveEditorStatePort {
  readLiveState(): Promise<EditorLiveState>;
  liveChangesSince(revision: ContextRevision, waitMs?: number): Promise<EditorChange[]>;
}

export interface EditorAsset {
  id: string;
  kind: "transition" | "effect" | "title" | "generator" | "audio-effect" | "template";
  name: string;
  vendor: string;
  metadata: Record<string, unknown>;
  compatibility?: {
    timelineKinds?: string[];
    mediaKinds?: string[];
  };
}

export interface AssetSearchQuery {
  query?: string;
  kind?: EditorAsset["kind"];
  vendor?: string;
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

export interface VisualAnalyzer {
  analyze(input: AnalysisInput, range?: TimeRange): Promise<VisualAnalysis>;
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
