import type {
  AnalyzerSkillCapability,
  EditorSkillCapability,
  SkillManifest,
  SkillRequirement,
  SkillOperation,
} from "../domain/skills.js";
import {
  SKILL_OPERATIONS,
} from "../domain/skills.js";
import type {
  AnalyzerCapabilities,
  EditorCapabilities,
  EditorIdentity,
  RuntimeCapabilities,
} from "../domain/capabilities.js";
import type { ContextRevision } from "../domain/primitives.js";

export const SKILL_EDITOR_CAPABILITIES = [
  "projectRead",
  "timelineSnapshotRead",
  "timelineWrite",
  "timelineArtifactWrite",
  "readAfterWrite",
  "rollback",
  "assetDiscovery",
  "liveStateRead",
  "playheadWrite",
  "frameCapture",
  "artifactPublish",
  "projectCatalogRead",
  "projectSelection",
  "compositeTransactions",
  "videoExport",
  "mediaImport",
  "mediaPlacement",
  "titlePlacement",
  "clipMove",
  "clipReplace",
  "clipRemoval",
  "transitionPlacement",
  "audioAttachment",
  "audioMixing",
  "noiseReduction",
  "colorCorrection",
] as const satisfies readonly EditorSkillCapability[];

export const SKILL_ANALYZER_CAPABILITIES = [
  "speechTranscribe",
  "speechVad",
  "audioLoudness",
  "audioNoise",
  "visualTrack",
  "metadataDescribe",
] as const satisfies readonly AnalyzerSkillCapability[];

export type SkillRequirementReasonCode =
  | "MISSING_EDITOR_CAPABILITY"
  | "MISSING_ANALYZER_CAPABILITY"
  | "UNSUPPORTED_SEMANTIC_OPERATION"
  | "UNKNOWN_REQUIREMENT"
  | "EMPTY_REQUIREMENT_GROUP"
  | "NO_ALTERNATIVE_SATISFIED";

export interface SkillRequirementDiagnostic {
  path: string;
  code: SkillRequirementReasonCode;
  requirement: unknown;
  name: string;
  message: string;
}

export interface SkillResolutionContext {
  capabilities: RuntimeCapabilities;
  editor?: EditorIdentity;
  revision?: ContextRevision;
}

export interface SkillAvailability {
  skillId: string;
  skillVersion: string;
  available: boolean;
  satisfiedRequirementPath: string[];
  missingRequirements: SkillRequirementDiagnostic[];
  reasonCodes: SkillRequirementReasonCode[];
  context: {
    editor?: EditorIdentity;
    backend: string;
    revision?: ContextRevision;
  };
}

export class SkillRequirementsUnavailableError extends Error {
  public readonly code = "SKILL_REQUIREMENTS_UNMET" as const;

  public constructor(public readonly availability: SkillAvailability) {
    super(`SKILL_REQUIREMENTS_UNMET: ${availability.missingRequirements.map((item) => item.message).join("; ")}`);
    this.name = "SkillRequirementsUnavailableError";
  }
}

export function resolveSkillRequirements(
  manifest: Pick<SkillManifest, "id" | "version" | "requirements">,
  context: SkillResolutionContext,
): SkillAvailability {
  const result = evaluateRequirement(manifest.requirements, context.capabilities, "requirements");
  const missingRequirements = result.missingRequirements;
  const reasonCodes = [...new Set(missingRequirements.map((item) => item.code))];
  const backend = context.capabilities.families?.connection.status.backend ?? context.editor?.backend ?? "unknown";
  return {
    skillId: manifest.id,
    skillVersion: manifest.version,
    available: result.available,
    satisfiedRequirementPath: result.satisfiedPath,
    missingRequirements,
    reasonCodes,
    context: {
      ...(context.editor ? { editor: structuredClone(context.editor) } : {}),
      backend,
      ...(context.revision ? { revision: structuredClone(context.revision) } : {}),
    },
  };
}

export function assertSkillRequirements(
  manifest: Pick<SkillManifest, "id" | "version" | "requirements">,
  context: SkillResolutionContext,
): SkillAvailability {
  const availability = resolveSkillRequirements(manifest, context);
  if (!availability.available) throw new SkillRequirementsUnavailableError(availability);
  return availability;
}

interface RequirementEvaluation {
  available: boolean;
  satisfiedPath: string[];
  missingRequirements: SkillRequirementDiagnostic[];
}

function evaluateRequirement(
  requirement: SkillRequirement,
  capabilities: RuntimeCapabilities,
  path: string,
): RequirementEvaluation {
  if (!isRecord(requirement) || typeof requirement.type !== "string") {
    return unknownRequirement(path, requirement);
  }
  if (requirement.type === "allOf") {
    if (!Array.isArray(requirement.requirements) || requirement.requirements.length === 0) {
      return emptyGroup(path, requirement);
    }
    const children = requirement.requirements.map((child, index) => evaluateRequirement(child, capabilities, `${path}.requirements[${index}]`));
    return {
      available: children.every((child) => child.available),
      satisfiedPath: children.flatMap((child) => child.satisfiedPath),
      missingRequirements: children.flatMap((child) => child.missingRequirements),
    };
  }
  if (requirement.type === "anyOf") {
    if (!Array.isArray(requirement.requirements) || requirement.requirements.length === 0) {
      return emptyGroup(path, requirement);
    }
    const children = requirement.requirements.map((child, index) => evaluateRequirement(child, capabilities, `${path}.requirements[${index}]`));
    const satisfied = children.find((child) => child.available);
    if (satisfied) return { available: true, satisfiedPath: satisfied.satisfiedPath, missingRequirements: [] };
    return {
      available: false,
      satisfiedPath: [],
      missingRequirements: [
        ...children.flatMap((child) => child.missingRequirements),
        diagnostic(path, "NO_ALTERNATIVE_SATISFIED", requirement, "anyOf", "no alternative requirement path is satisfied"),
      ],
    };
  }
  if (requirement.type === "editor") {
    if (!isKnownEditorCapability(requirement.capability)) return unknownRequirement(path, requirement);
    if (Boolean(capabilities.editor[requirement.capability])) {
      return { available: true, satisfiedPath: [path], missingRequirements: [] };
    }
    return {
      available: false,
      satisfiedPath: [],
      missingRequirements: [diagnostic(path, "MISSING_EDITOR_CAPABILITY", requirement, requirement.capability, `editor capability ${requirement.capability} is unavailable`)],
    };
  }
  if (requirement.type === "analyzer") {
    if (!isKnownAnalyzerCapability(requirement.capability)) return unknownRequirement(path, requirement);
    if (Boolean(capabilities.analyzers[requirement.capability])) {
      return { available: true, satisfiedPath: [path], missingRequirements: [] };
    }
    return {
      available: false,
      satisfiedPath: [],
      missingRequirements: [diagnostic(path, "MISSING_ANALYZER_CAPABILITY", requirement, requirement.capability, `analyzer capability ${requirement.capability} is unavailable`)],
    };
  }
  if (requirement.type === "operation") {
    if (!isKnownOperation(requirement.operation)) return unknownRequirement(path, requirement);
    if (capabilities.editor.semanticOperations?.[requirement.operation] === true) {
      return { available: true, satisfiedPath: [path], missingRequirements: [] };
    }
    return {
      available: false,
      satisfiedPath: [],
      missingRequirements: [diagnostic(path, "UNSUPPORTED_SEMANTIC_OPERATION", requirement, requirement.operation, `semantic operation ${requirement.operation} is unavailable`)],
    };
  }
  return unknownRequirement(path, requirement);
}

function diagnostic(
  path: string,
  code: SkillRequirementReasonCode,
  requirement: unknown,
  name: string,
  message: string,
): SkillRequirementDiagnostic {
  return { path, code, requirement: structuredClone(requirement), name, message };
}

function unknownRequirement(path: string, requirement: unknown): RequirementEvaluation {
  return {
    available: false,
    satisfiedPath: [],
    missingRequirements: [diagnostic(path, "UNKNOWN_REQUIREMENT", requirement, "unknown", "unknown Skill requirement fails closed")],
  };
}

function emptyGroup(path: string, requirement: unknown): RequirementEvaluation {
  return {
    available: false,
    satisfiedPath: [],
    missingRequirements: [diagnostic(path, "EMPTY_REQUIREMENT_GROUP", requirement, "empty-group", "empty Skill requirement group fails closed")],
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isKnownEditorCapability(value: unknown): value is keyof EditorCapabilities {
  return typeof value === "string" && (SKILL_EDITOR_CAPABILITIES as readonly string[]).includes(value);
}

function isKnownAnalyzerCapability(value: unknown): value is keyof AnalyzerCapabilities {
  return typeof value === "string" && (SKILL_ANALYZER_CAPABILITIES as readonly string[]).includes(value);
}

function isKnownOperation(value: unknown): value is SkillOperation {
  return typeof value === "string" && (SKILL_OPERATIONS as readonly string[]).includes(value);
}
