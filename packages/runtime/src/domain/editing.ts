import type { ContextRevision, RationalTime, TimeRange } from "./primitives.js";

import type { Marker, ProjectSnapshot } from "./project.js";

import type { TimelineDiff } from "./diff.js";

import type { VerificationPolicy, VerificationReport } from "./verification.js";

export interface ArtifactEditTarget {
  kind: "artifact";
  artifactId: string;
  artifactPath: string;
}

export interface EditorTimelineEditTarget {
  kind: "editor.timeline";
  projectId: string;
  sequenceId: string;
}

export type EditTarget = ArtifactEditTarget | EditorTimelineEditTarget;

export interface ArtifactEditTargetInput {
  artifactPath: string;
}

export interface EditorTimelineEditTargetInput {
  projectId: string;
  sequenceId: string;
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

export interface ImportMediaOperation {
  type: "media.import";
  mediaId: string;
  source: string;
  mediaKind: "video" | "audio";
  duration: number;
  sourceDigest: string;
}

export interface AddMediaOperation {
  type: "timeline.media.add";
  occurrenceId: string;
  mediaId: string;
  role: "video" | "music" | "audio";
  start: number;
  duration: number;
  targetLane?: "primary" | number;
}

export interface SetAudioFadesOperation {
  type: "timeline.audio.fades";
  clipId: string;
  fadeIn: number;
  fadeOut: number;
}

export interface MusicImportSource {
  mediaId: string;
  source: string;
  duration: number;
  sourceDigest: string;
}

export interface MusicAddRequest {
  baseRevision: ContextRevision;
  occurrenceId: string;
  mediaId?: string;
  import?: MusicImportSource;
  placement: "append" | "insert";
  start?: number;
  duration?: number;
  targetLane: number;
  gainDb?: number;
  fadeIn?: number;
  fadeOut?: number;
  ducking?: {
    enabled: boolean;
    dialogueClipIds?: string[];
    reductionDb?: number;
  };
  verification?: VerificationPolicy;
}

export interface AddTitleOperation {
  type: "timeline.title.add";
  occurrenceId: string;
  assetId: string;
  text: string;
  start: number;
  duration: number;
  targetLane: number;
}

export interface MoveMediaOperation {
  type: "timeline.media.move";
  occurrenceId: string;
  start: number;
  targetLane?: "primary" | number;
}

export interface ReplaceMediaOperation {
  type: "timeline.media.replace";
  occurrenceId: string;
  mediaId: string;
  duration?: number;
}

export interface RemoveMediaOperation {
  type: "timeline.media.remove";
  occurrenceId: string;
}

export interface AddTransitionOperation {
  type: "timeline.transition.add";
  transitionId: string;
  assetId: string;
  beforeClipId: string;
  afterClipId: string;
  duration: number;
}

export interface AttachAudioOperation {
  type: "timeline.audio.attach";
  occurrenceId: string;
  targetClipId: string;
  mediaId: string;
  startOffset?: number;
  duration?: number;
}

export interface MixAudioOperation {
  type: "timeline.audio.mix";
  clipId: string;
  gainDb?: number;
  fadeIn?: number;
  fadeOut?: number;
}

export type WorkflowOperation = EditOperation
  | ImportMediaOperation
  | AddMediaOperation
  | SetAudioFadesOperation
  | AddTitleOperation
  | MoveMediaOperation
  | ReplaceMediaOperation
  | RemoveMediaOperation
  | AddTransitionOperation
  | AttachAudioOperation
  | MixAudioOperation;

export interface CompositeEditRequest {
  baseRevision: ContextRevision;
  operations: WorkflowOperation[];
  verification?: VerificationPolicy;
}

export interface CompositeEditPreview {
  previewToken: string;
  target: EditTarget;
  baseRevision: ContextRevision;
  operations: WorkflowOperation[];
  expectedDiff: TimelineDiff;
  warnings: string[];
  expiresAt: string;
  verification?: VerificationPolicy;
}

export interface EditTransaction {
  id: string;
  target?: EditTarget;
  artifactDigest?: string;
  operation?: EditOperation;
  intent: string;
  planned: WorkflowOperation[];
  applied: WorkflowOperation[];
  baseRevision: ContextRevision;
  before: ProjectSnapshot;
  after: ProjectSnapshot;
  attemptedAfter: ProjectSnapshot;
  diff: TimelineDiff;
  verificationPolicy?: VerificationPolicy;
  verification?: VerificationReport;
  status: "APPLIED" | "VERIFIED" | "FAILED" | "ROLLED_BACK" | "ACCEPTED";
}
