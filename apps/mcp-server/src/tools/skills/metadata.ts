import { z } from "zod/v3";

export type SkillToolName = "skill.list" | "skill.inspect" | "skill.preview" | "skill.execute";
export type SkillToolMode = "fixture" | "headless" | "editor";
export type SkillToolEffect = "read" | "preview" | "write";
export type SkillToolOutputContract = "SkillInspection[]" | "SkillInspection" | "SkillPreview" | "SkillExecution";

export interface SkillToolMetadata {
  name: SkillToolName;
  description: string;
  inputSchema: z.ZodRawShape;
  outputContract: SkillToolOutputContract;
  capabilityModes: readonly SkillToolMode[];
  capabilities: readonly string[];
  effect: SkillToolEffect;
  approval: { kind: "none"; required: false } | { kind: "runtime-preview-token"; required: true };
  errorCodes: readonly string[];
  examples: readonly Readonly<Record<string, unknown>>[];
}

export const skillRevisionValueSchema = z.object({
  id: z.string(),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string(),
});

const allSkillToolModes: readonly SkillToolMode[] = ["fixture", "headless", "editor"];

export const SKILL_TOOL_METADATA: readonly SkillToolMetadata[] = [
  {
    name: "skill.list",
    description: "List registered versioned Framekit Skills with current capability availability.",
    inputSchema: {},
    outputContract: "SkillInspection[]",
    capabilityModes: allSkillToolModes,
    capabilities: ["skill-availability"],
    effect: "read",
    approval: { kind: "none", required: false },
    errorCodes: ["SKILL_ERROR"],
    examples: [{ input: {} }],
  },
  {
    name: "skill.inspect",
    description: "Inspect one registered Framekit Skill version and its current capability availability.",
    inputSchema: {
      skill: z.string().min(1),
      version: z.string().min(1).optional(),
    },
    outputContract: "SkillInspection",
    capabilityModes: allSkillToolModes,
    capabilities: ["skill-availability"],
    effect: "read",
    approval: { kind: "none", required: false },
    errorCodes: ["SKILL_NOT_FOUND", "SKILL_VERSION_NOT_FOUND", "SKILL_ERROR"],
    examples: [{ input: { skill: "color-correction" } }],
  },
  {
    name: "skill.preview",
    description: "Validate and preview a registered Skill without mutating the editor.",
    inputSchema: {
      skill: z.string().min(1),
      version: z.string().min(1).optional(),
      arguments: z.record(z.unknown()),
    },
    outputContract: "SkillPreview",
    capabilityModes: allSkillToolModes,
    capabilities: ["runtime-skill-requirements", "revision-bound-preview"],
    effect: "preview",
    approval: { kind: "none", required: false },
    errorCodes: ["SKILL_INPUT_INVALID", "SKILL_REQUIREMENTS_UNMET", "STALE_CONTEXT", "SKILL_ERROR"],
    examples: [{
      input: {
        skill: "color-correction",
        arguments: { baseRevision: { id: "revision-1", sequence: 1, timestamp: "2026-10-01T00:00:00.000Z" }, clipId: "clip-1", preset: "warm" },
      },
    }],
  },
  {
    name: "skill.execute",
    description: "Execute only a runtime-issued Skill preview token and return verification/rollback evidence.",
    inputSchema: {
      previewToken: z.string().min(1),
    },
    outputContract: "SkillExecution",
    capabilityModes: allSkillToolModes,
    capabilities: ["runtime-issued-preview-token", "revision-check", "verification", "rollback"],
    effect: "write",
    approval: { kind: "runtime-preview-token", required: true },
    errorCodes: ["SKILL_PREVIEW_TOKEN_INVALID", "SKILL_PREVIEW_TOKEN_EXPIRED", "SKILL_REQUIREMENTS_UNMET", "STALE_CONTEXT", "SKILL_ERROR"],
    examples: [{ input: { previewToken: "skill-preview-issued-by-runtime" } }],
  },
];
