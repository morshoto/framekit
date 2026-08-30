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
  clipMove?: boolean;
  clipReplace?: boolean;
  clipRemoval?: boolean;
  transitionPlacement?: boolean;
  audioAttachment?: boolean;
  audioMixing?: boolean;
}

export interface AnalyzerCapabilities {
  speechTranscribe: boolean;
  speechVad: boolean;
  audioLoudness: boolean;
  visualTrack: boolean;
  metadataDescribe?: boolean;
}

export const CAPABILITY_SCHEMA_VERSION = 1 as const;

export type CapabilityGuarantee =
  | "none"
  | "observed"
  | "artifact-write"
  | "canonical-read"
  | "canonical-write"
  | "native-verified"
  | "verified";

export interface CapabilityDescriptor {
  available: boolean;
  backend: string;
  guarantee: CapabilityGuarantee;
  unavailableReason?: string;
}

export type NativeCapabilityOperation =
  | "selectionWrite"
  | "undo"
  | "mediaLibrarySearch"
  | "mediaImport"
  | "mediaSelection"
  | "mediaAppendSelected"
  | "timelineOccurrenceLocate"
  | "bladeAtPlayhead"
  | "deleteRange"
  | "trimToDuration"
  | "mediaAppend"
  | "mediaInsert"
  | "titlePlacement"
  | "timelineFocus"
  | "projectCreation"
  | "clipInsertion"
  | "clipMovement";

export interface CapabilityFamilies {
  connection: {
    status: CapabilityDescriptor;
  };
  observation: {
    timeline: CapabilityDescriptor;
    media: CapabilityDescriptor;
  };
  canonicalDocument: {
    read: CapabilityDescriptor;
    write: CapabilityDescriptor;
    artifactWrite: CapabilityDescriptor;
  };
  native: Record<NativeCapabilityOperation, CapabilityDescriptor>;
  publishing: {
    projectCreation: CapabilityDescriptor;
  };
  export: {
    timeline: CapabilityDescriptor;
  };
  analyzers: {
    speechTranscribe: CapabilityDescriptor;
    speechVad: CapabilityDescriptor;
    audioLoudness: CapabilityDescriptor;
    visualTrack: CapabilityDescriptor;
  };
}

export interface RuntimeCapabilities {
  editor: EditorCapabilities;
  analyzers: AnalyzerCapabilities;
  /** Present in the versioned operation-level capability contract. */
  schemaVersion?: typeof CAPABILITY_SCHEMA_VERSION;
  /** Present in the versioned operation-level capability contract. */
  families?: CapabilityFamilies;
}

export interface VersionedRuntimeCapabilities extends RuntimeCapabilities {
  schemaVersion: typeof CAPABILITY_SCHEMA_VERSION;
  families: CapabilityFamilies;
}
