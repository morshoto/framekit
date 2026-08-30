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
  /** The backend can return image data for an exact timeline position. */
  frameCapture: boolean;
  playbackControl?: boolean;
  /** Canonical artifact can be imported as a new editor project. */
  timelinePublishNewProject?: boolean;
  /** The backend can enumerate stable project and sequence identities. */
  projectCatalogRead?: boolean;
  /** The backend can select a project and, when needed, one of its sequences. */
  projectSelection?: boolean;
  /** The backend can atomically preview and apply ordered workflow operations. */
  compositeTransactions?: boolean;
  /** The backend can export the active timeline to a verified local video file. */
  videoExport?: boolean;
  mediaImport?: boolean;
  mediaPlacement?: boolean;
  titlePlacement?: boolean;
}

export interface AnalyzerCapabilities {
  speechTranscribe: boolean;
  speechVad: boolean;
  audioLoudness: boolean;
  visualTrack: boolean;
  metadataDescribe?: boolean;
}

export interface RuntimeCapabilities {
  editor: EditorCapabilities;
  analyzers: AnalyzerCapabilities;
}
