import type { ContextRevision, RationalTime } from "./primitives.js";

import type { ProjectSnapshot } from "./project.js";

import type { EditorLiveState, EditorChange, ContextChangeSet, ProjectCatalog, ProjectSelection } from "./context.js";

import type { CapturedFrameSource } from "./media.js";

import type { EditorIdentity, RuntimeCapabilities } from "./capabilities.js";

import type { WorkflowOperation, EditOperation } from "./editing.js";

export interface EditorAdapter {
  read(): Promise<ProjectSnapshot>;
  /** Apply atomically and return the resulting revision for read-failure rollback. */
  apply(operation: EditOperation, expectedRevision: ContextRevision): Promise<ContextRevision>;
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
  /** Capture only if the active editor target still matches the inspected revision. */
  captureFrame?(position: RationalTime, expectedRevision: ContextRevision): Promise<CapturedFrameSource>;
  previewTransaction?(operations: WorkflowOperation[], expectedRevision: ContextRevision): Promise<ProjectSnapshot>;
  applyTransaction?(operations: WorkflowOperation[], expectedRevision: ContextRevision): Promise<void>;
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
