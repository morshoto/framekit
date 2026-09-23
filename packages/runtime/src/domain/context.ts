import type { ContextRevision, RationalTime, RationalTimeRange } from "./primitives.js";

import type { ProjectSnapshot } from "./project.js";

import type { MediaContext } from "./media.js";

import type { TimelineDiff, AssetChange } from "./diff.js";

import type { ProjectSelectionMode, RuntimeCapabilities } from "./capabilities.js";

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

export interface ProjectCatalogSource {
  source: string;
  backend: string;
  guarantee: "observed" | "canonical-read";
}

export interface ProjectCatalogLiveSource {
  source: string;
  backend: string;
  guarantee: "observed";
}

export type ProjectCatalogIdentityMatchMethod = "stable-id" | "name-only" | "unresolved";

export interface ProjectCatalogIdentityMatch {
  method: ProjectCatalogIdentityMatchMethod;
  catalogId?: string;
  liveId?: string;
}

export interface ProjectCatalogReconciliation {
  status: "matched" | "unresolved" | "stale";
  project: ProjectCatalogIdentityMatch;
  sequence: ProjectCatalogIdentityMatch;
  beforeRevision?: ContextRevision;
  afterRevision?: ContextRevision;
  reason?: string;
}

export interface ProjectCatalogSelectionCapability {
  available: boolean;
  mode: ProjectSelectionMode;
  unavailableReason?: string;
}

export interface ProjectCatalogProvenance {
  catalog: ProjectCatalogSource;
  live?: ProjectCatalogLiveSource & { state: EditorLiveState };
  reconciliation: ProjectCatalogReconciliation;
  selection: ProjectCatalogSelectionCapability;
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
  provenance?: ProjectCatalogProvenance;
}

export interface ProjectSelection {
  projectId: string;
  sequenceId?: string;
}

export interface ProjectSelectionResult extends ProjectCatalog {
  requestedTarget: ProjectSelection;
  observedActiveTarget: {
    projectId: string;
    sequenceId: string;
  };
  observedRevision: ContextRevision;
}

export function createProjectSelectionResult(
  catalog: ProjectCatalog,
  requestedTarget: ProjectSelection,
  observedRevision: ContextRevision,
): ProjectSelectionResult {
  if (!catalog.activeProjectId || !catalog.activeSequenceId) {
    throw new Error("TARGET_MISMATCH: project selection did not produce an active target");
  }
  return {
    ...catalog,
    requestedTarget: { ...requestedTarget },
    observedActiveTarget: {
      projectId: catalog.activeProjectId,
      sequenceId: catalog.activeSequenceId,
    },
    observedRevision: { ...observedRevision },
  };
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
