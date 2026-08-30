import { CAPABILITY_SCHEMA_VERSION } from "./domain/capabilities.js";
import type {
  CapabilityDescriptor,
  CapabilityFamilies,
  NativeCapabilityOperation,
  RuntimeCapabilities,
  VersionedRuntimeCapabilities,
} from "./domain/capabilities.js";

export type CanonicalTimelineMode = "metadata-only" | "canonical-read" | "canonical-write";

export function canonicalTimelineMode(capabilities: RuntimeCapabilities): CanonicalTimelineMode {
  const editor = capabilities.editor;
  const hasExplicitTargeting = Boolean(editor.projectCatalogRead && editor.projectSelection);
  if (
    editor.projectRead
    && editor.timelineSnapshotRead
    && hasExplicitTargeting
    && editor.timelineWrite
    && editor.readAfterWrite
    && editor.rollback
  ) {
    return "canonical-write";
  }
  if (editor.projectRead && editor.timelineSnapshotRead && hasExplicitTargeting) return "canonical-read";
  return "metadata-only";
}

export function withCanonicalTimelineMode(capabilities: RuntimeCapabilities): RuntimeCapabilities {
  const normalized = {
    ...capabilities,
    editor: {
      ...capabilities.editor,
      canonicalTimelineMode: canonicalTimelineMode(capabilities),
    },
  };
  const previous = capabilities.families;
  if (!previous) return normalized;
  return withCapabilityFamilies(normalized, {
    backend: previous.connection.status.backend,
    nativeBackend: previous.native.selectionWrite.backend,
    publishingBackend: previous.publishing.projectCreation.backend,
    exportBackend: previous.export.timeline.backend,
    analyzerBackend: previous.analyzers.speechTranscribe.backend,
    connection: previous.connection.status,
    native: nativeAvailability(previous.native),
    publishing: previous.publishing.projectCreation,
    export: previous.export.timeline,
  });
}

export interface CapabilityFamilyOptions {
  backend?: string;
  connectionBackend?: string;
  nativeBackend?: string;
  publishingBackend?: string;
  exportBackend?: string;
  analyzerBackend?: string;
  connection?: boolean | CapabilityDescriptor;
  native?: Partial<Record<NativeCapabilityOperation, boolean>>;
  publishing?: boolean | CapabilityDescriptor;
  export?: boolean | CapabilityDescriptor;
}

/**
 * Adds the versioned operation-level contract while retaining the legacy
 * boolean fields used by existing runtime consumers.
 */
export function withCapabilityFamilies(
  capabilities: RuntimeCapabilities,
  options: CapabilityFamilyOptions = {},
): VersionedRuntimeCapabilities {
  const previous = capabilities.families;
  const backend = options.backend ?? previous?.connection.status.backend ?? "unknown";
  const normalized = {
    ...capabilities,
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    editor: {
      ...capabilities.editor,
      canonicalTimelineMode: canonicalTimelineMode(capabilities),
    },
  };
  const editor = normalized.editor;
  const native = {
    ...nativeAvailability(previous?.native),
    ...options.native,
  };
  const families: CapabilityFamilies = {
    connection: {
      status: descriptorFrom(
        options.connection ?? previous?.connection.status ?? true,
        options.connectionBackend ?? backend,
        "observed",
        "editor connection is unavailable",
      ),
    },
    observation: {
      timeline: descriptorFrom(
        editor.timelineSnapshotRead || editor.liveStateRead,
        backend,
        editor.timelineSnapshotRead ? "canonical-read" : "observed",
        "timeline observation is unavailable",
      ),
      media: descriptorFrom(
        editor.timelineSnapshotRead && editor.projectRead,
        backend,
        "canonical-read",
        "media observation is unavailable",
      ),
    },
    canonicalDocument: {
      read: descriptorFrom(
        editor.canonicalTimelineMode === "canonical-read"
          || editor.canonicalTimelineMode === "canonical-write",
        backend,
        "canonical-read",
        "canonical timeline reads are unavailable",
      ),
      write: descriptorFrom(
        editor.canonicalTimelineMode === "canonical-write",
        backend,
        "canonical-write",
        "canonical timeline writes are unavailable",
      ),
      artifactWrite: descriptorFrom(
        editor.timelineArtifactWrite,
        backend,
        "artifact-write",
        "canonical artifact writes are unavailable",
      ),
    },
    native: nativeFamily(native, options.nativeBackend ?? backend),
    publishing: {
      projectCreation: descriptorFrom(
        options.publishing ?? previous?.publishing.projectCreation ?? false,
        options.publishingBackend ?? backend,
        "verified",
        "new project publishing is unavailable",
      ),
    },
    export: {
      timeline: descriptorFrom(
        options.export ?? previous?.export.timeline ?? false,
        options.exportBackend ?? backend,
        "verified",
        "timeline export is unavailable",
      ),
    },
    analyzers: {
      speechTranscribe: analyzerDescriptor(capabilities.analyzers.speechTranscribe, options.analyzerBackend ?? backend, "speech transcription"),
      speechVad: analyzerDescriptor(capabilities.analyzers.speechVad, options.analyzerBackend ?? backend, "speech VAD"),
      audioLoudness: analyzerDescriptor(capabilities.analyzers.audioLoudness, options.analyzerBackend ?? backend, "audio loudness analysis"),
      visualTrack: analyzerDescriptor(capabilities.analyzers.visualTrack, options.analyzerBackend ?? backend, "visual analysis"),
    },
  };
  return { ...normalized, families };
}

function descriptorFrom(
  value: boolean | CapabilityDescriptor,
  backend: string,
  guarantee: Exclude<CapabilityDescriptor["guarantee"], "none">,
  unavailableReason: string,
): CapabilityDescriptor {
  if (typeof value !== "boolean") return value;
  return value
    ? { available: true, backend, guarantee }
    : { available: false, backend, guarantee: "none", unavailableReason };
}

function analyzerDescriptor(available: boolean, backend: string, operation: string): CapabilityDescriptor {
  return descriptorFrom(available, backend, "verified", `${operation} is unavailable`);
}

function nativeFamily(
  native: Partial<Record<NativeCapabilityOperation, boolean>>,
  backend: string,
): Record<NativeCapabilityOperation, CapabilityDescriptor> {
  const nativeOperations: NativeCapabilityOperation[] = [
    "selectionWrite",
    "undo",
    "mediaLibrarySearch",
    "mediaImport",
    "mediaSelection",
    "mediaAppendSelected",
    "timelineOccurrenceLocate",
    "bladeAtPlayhead",
    "deleteRange",
    "trimToDuration",
    "mediaAppend",
    "mediaInsert",
    "titlePlacement",
    "timelineFocus",
    "projectCreation",
    "clipInsertion",
    "clipMovement",
  ];
  return Object.fromEntries(nativeOperations.map((operation) => [
    operation,
    descriptorFrom(
      Boolean(native[operation]),
      backend,
      "native-verified",
      `native ${nativeOperationLabel(operation)} is unavailable`,
    ),
  ])) as Record<NativeCapabilityOperation, CapabilityDescriptor>;
}

function nativeOperationLabel(operation: NativeCapabilityOperation): string {
  return operation.replace(/[A-Z]/g, (character) => ` ${character.toLowerCase()}`);
}

function nativeAvailability(
  native: CapabilityFamilies["native"] | undefined,
): Partial<Record<NativeCapabilityOperation, boolean>> {
  if (!native) return {};
  return Object.fromEntries(Object.entries(native).map(([operation, capability]) => [operation, capability.available]));
}
