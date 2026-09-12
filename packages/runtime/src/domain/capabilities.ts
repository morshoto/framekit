import type { SkillOperation } from "./skills.js";

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
  /** The managed artifact can be imported as a new editor project. */
  artifactPublish?: boolean;
  /** Legacy alias for artifactPublish used by editor-first routing. */
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
  pictureInPicture?: boolean;
  titlePlacement?: boolean;
  clipMove?: boolean;
  clipReplace?: boolean;
  clipRemoval?: boolean;
  transitionPlacement?: boolean;
  audioAttachment?: boolean;
  audioMixing?: boolean;
  noiseReduction?: boolean;
  colorCorrection?: boolean;
  /** The backend can add and verify a bounded or supplied-alpha mask. */
  masking?: boolean;
  /** The backend can add and verify a person cutout. */
  personCutout?: boolean;
  /** Explicit semantic operation guarantees; timelineWrite alone is insufficient. */
  semanticOperations?: Partial<Record<SkillOperation, boolean>>;
}

export interface AnalyzerCapabilities {
  speechTranscribe: boolean;
  speechVad: boolean;
  speechCapability?: "unavailable" | "transcription-only" | "transcription-plus-vad";
  audioLoudness: boolean;
  audioNoise?: boolean;
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

export interface CapabilityUnavailableErrorPayload {
  code: "CAPABILITY_UNAVAILABLE";
  message: string;
  operation: string;
  capability: string;
  available: false;
  backend: string;
  guarantee: "none";
  unavailableReason: string;
}

export class CapabilityUnavailableError extends Error {
  public readonly code = "CAPABILITY_UNAVAILABLE" as const;
  public readonly available = false as const;
  public readonly backend: string;
  public readonly guarantee = "none" as const;
  public readonly unavailableReason: string;

  public constructor(
    public readonly operation: string,
    public readonly capability: string,
    descriptor: CapabilityDescriptor,
  ) {
    const unavailableReason = descriptor.unavailableReason ?? `${capability} is unavailable`;
    super(`CAPABILITY_UNAVAILABLE: ${operation} requires ${capability}: ${unavailableReason}`);
    this.name = "CapabilityUnavailableError";
    this.backend = descriptor.backend;
    this.unavailableReason = unavailableReason;
  }

  public toJSON(): CapabilityUnavailableErrorPayload {
    return {
      code: this.code,
      message: `${this.operation} requires ${this.capability}`,
      operation: this.operation,
      capability: this.capability,
      available: this.available,
      backend: this.backend,
      guarantee: this.guarantee,
      unavailableReason: this.unavailableReason,
    };
  }
}

export function serializeCapabilityUnavailableError(
  error: unknown,
): CapabilityUnavailableErrorPayload | undefined {
  return error instanceof CapabilityUnavailableError ? error.toJSON() : undefined;
}

export type EditingCapabilityOperation =
  | "compositeTransactions"
  | "titlePlacement"
  | "pictureInPicture"
  | "masking"
  | "personCutout";

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
  | "titleDiscovery"
  | "timelineFocus"
  | "projectCreation"
  | "clipInsertion"
  | "clipMovement"
  | "transitionDiscovery"
  | "transitionPlacement"
  | "pictureInPicture"
  | "masking";

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
  editing: Record<EditingCapabilityOperation, CapabilityDescriptor>;
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
    audioNoise?: CapabilityDescriptor;
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
