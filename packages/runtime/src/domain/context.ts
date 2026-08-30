import type { ContextRevision, RationalTime, RationalTimeRange } from "./primitives.js";

import type { ProjectSnapshot } from "./project.js";

import type { MediaContext } from "./media.js";

import type { TimelineDiff, AssetChange } from "./diff.js";

import type { RuntimeCapabilities } from "./capabilities.js";

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
