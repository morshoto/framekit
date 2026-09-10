import type { RuntimeCapabilities } from "./capabilities.js";
import type { ContextRevision, TimeRange } from "./primitives.js";
import type { ProjectSnapshot } from "./project.js";
import type { WorkflowOperation } from "./editing.js";
import type { TimelineDiff } from "./diff.js";
import type { VerificationPolicy, VerificationReport } from "./verification.js";
import type { AudioMeasurement, NoiseMeasurement, SpeechAnalysis } from "./media.js";

/** Version of the editor-independent Skill contract. */
export const SKILL_CONTRACT_VERSION = 1 as const;

/** The ordered phases shared by every Skill implementation. */
export const SKILL_LIFECYCLE = [
  "discover",
  "resolve",
  "plan",
  "preview",
  "execute",
  "verify",
  "accept",
  "rollback",
] as const;

export type SkillLifecyclePhase = (typeof SKILL_LIFECYCLE)[number];

export type SkillSchema =
  | { type: "string"; description?: string; enum?: string[]; minLength?: number }
  | { type: "number"; description?: string; minimum?: number; maximum?: number }
  | { type: "integer"; description?: string; minimum?: number; maximum?: number }
  | { type: "boolean"; description?: string }
  | { type: "array"; description?: string; items: SkillSchema; minItems?: number }
  | { type: "object"; description?: string; properties: Record<string, SkillSchema>; required?: string[]; additionalProperties?: boolean };

/** A transport-neutral input schema carried by a Skill manifest. */
export interface SkillInputSchema {
  type: "object";
  properties: Record<string, SkillSchema>;
  required?: string[];
  additionalProperties?: boolean;
}

export type EditorSkillCapability =
  | "projectRead"
  | "timelineSnapshotRead"
  | "timelineWrite"
  | "timelineArtifactWrite"
  | "readAfterWrite"
  | "rollback"
  | "assetDiscovery"
  | "liveStateRead"
  | "playheadWrite"
  | "frameCapture"
  | "artifactPublish"
  | "projectCatalogRead"
  | "projectSelection"
  | "compositeTransactions"
  | "videoExport"
  | "mediaImport"
  | "mediaPlacement"
  | "titlePlacement"
  | "clipMove"
  | "clipReplace"
  | "clipRemoval"
  | "transitionPlacement"
  | "audioAttachment"
  | "audioMixing"
  | "noiseReduction"
  | "colorCorrection";

export type AnalyzerSkillCapability =
  | "speechTranscribe"
  | "speechVad"
  | "audioLoudness"
  | "audioNoise"
  | "visualTrack"
  | "metadataDescribe";

/** Semantic operation names are deliberately independent of editor commands. */
export const SKILL_OPERATIONS = [
  "rename-clip",
  "trim-clip",
  "set-gain",
  "reduce-noise",
  "set-color-correction",
  "ripple-delete",
  "add-marker",
  "media.import",
  "timeline.media.add",
  "timeline.audio.fades",
  "timeline.title.add",
  "timeline.media.move",
  "timeline.media.replace",
  "timeline.media.remove",
  "timeline.transition.add",
  "timeline.audio.attach",
  "timeline.audio.mix",
] as const satisfies readonly WorkflowOperation["type"][];

export type SkillOperation = (typeof SKILL_OPERATIONS)[number];

export type SkillRequirement =
  | { type: "allOf"; requirements: SkillRequirement[] }
  | { type: "anyOf"; requirements: SkillRequirement[] }
  | { type: "editor"; capability: EditorSkillCapability }
  | { type: "analyzer"; capability: AnalyzerSkillCapability }
  | { type: "operation"; operation: SkillOperation };

export interface SkillManifest {
  contractVersion: typeof SKILL_CONTRACT_VERSION;
  id: string;
  version: string;
  title: string;
  description: string;
  inputSchema: SkillInputSchema;
  requirements: SkillRequirement;
  verification?: VerificationPolicy;
}

export interface SkillPlanningContext {
  /** The snapshot is read-only input to a handler; it is not an adapter. */
  project: ProjectSnapshot;
  capabilities: RuntimeCapabilities;
  baseRevision: ContextRevision;
  analyzeSpeech?: (mediaId: string, range?: TimeRange) => Promise<SpeechAnalysis>;
  measureAudio?: (mediaId: string, occurrenceId: string) => Promise<AudioMeasurement>;
  measureNoise?: (mediaId: string, occurrenceId: string) => Promise<NoiseMeasurement>;
}

export interface SkillPlan {
  id: string;
  skillId: string;
  skillVersion: string;
  baseRevision: ContextRevision;
  normalizedInput: Record<string, unknown>;
  operations: WorkflowOperation[];
  affectedRanges: TimeRange[];
  warnings: string[];
  verification?: VerificationPolicy;
  details?: Record<string, unknown>;
}

export interface SkillPreview {
  previewToken: string;
  plan: SkillPlan;
  expectedDiff?: unknown;
  expiresAt: string;
}

export type SkillExecutionStatus = "VERIFIED" | "ROLLED_BACK" | "FAILED" | "SKIPPED";

export interface SkillRollbackResult {
  attempted: boolean;
  succeeded: boolean;
  transactionIds: string[];
  reason?: string;
}

export interface SkillExecution {
  status: SkillExecutionStatus;
  plan: Pick<SkillPlan, "id" | "skillId" | "skillVersion" | "baseRevision">;
  transactionIds: string[];
  diff?: TimelineDiff;
  verification?: VerificationReport;
  rollback: SkillRollbackResult;
}

export interface SkillHandler<Input extends Record<string, unknown> = Record<string, unknown>> {
  normalize(input: unknown): Promise<Input> | Input;
  plan(context: SkillPlanningContext, input: Input): Promise<Omit<SkillPlan, "id" | "skillId" | "skillVersion" | "baseRevision" | "normalizedInput">> | Omit<SkillPlan, "id" | "skillId" | "skillVersion" | "baseRevision" | "normalizedInput">;
}

/** Metadata and executable behavior are separate so manifests remain inspectable. */
export interface SkillDefinition<Input extends Record<string, unknown> = Record<string, unknown>> {
  manifest: SkillManifest;
  handler: SkillHandler<Input>;
}
