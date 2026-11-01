import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import type { AgentVideoRuntime, SkillPreview } from "@framekit/runtime";

/** Runtime capability and availability resolution stays behind this injected port. */
export type SkillToolsRuntime = Pick<AgentVideoRuntime,
  "listSkillAvailability" | "inspectSkillAvailability" | "previewSkill" | "executeSkill"
>;

const revisionValueSchema = z.object({
  id: z.string(),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string(),
});

export function registerSkillTools(server: McpServer, runtime: SkillToolsRuntime): void {
  server.registerTool("skill.list", {
    description: "List registered versioned Framekit Skills with current capability availability.",
    inputSchema: {},
  }, async () => {
    try {
      return jsonResult((await runtime.listSkillAvailability()).map(({ manifest, availability }) => ({
        ...manifest,
        availability,
      })));
    } catch (error) {
      return skillErrorResult(error);
    }
  });

  server.registerTool("skill.inspect", {
    description: "Inspect one registered Framekit Skill version and its current capability availability.",
    inputSchema: { skill: z.string().min(1), version: z.string().min(1).optional() },
  }, async ({ skill, version }) => {
    try {
      const { manifest, availability } = await runtime.inspectSkillAvailability(skill, version);
      return jsonResult({ ...manifest, availability });
    } catch (error) {
      return skillErrorResult(error);
    }
  });

  server.registerTool("skill.preview", {
    description: "Validate and preview a registered Skill without mutating the editor.",
    inputSchema: {
      skill: z.string().min(1),
      version: z.string().min(1).optional(),
      arguments: z.record(z.unknown()),
    },
  }, async ({ skill, version, arguments: skillArguments }) => {
    try {
      const baseRevision = revisionValueSchema.parse(skillArguments.baseRevision);
      const { baseRevision: _baseRevision, ...input } = skillArguments;
      return skillPreviewResult(await runtime.previewSkill({
        skillId: skill,
        ...(version ? { version } : {}),
        baseRevision,
        input,
      }));
    } catch (error) {
      return skillErrorResult(error);
    }
  });

  server.registerTool("skill.execute", {
    description: "Execute only a runtime-issued Skill preview token and return verification/rollback evidence.",
    inputSchema: {
      previewToken: z.string().min(1),
    },
  }, async ({ previewToken }) => {
    try {
      return jsonResult(await runtime.executeSkill(previewToken));
    } catch (error) {
      return skillErrorResult(error);
    }
  });
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

function skillErrorResult(error: unknown) {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof z.ZodError
    ? "SKILL_INPUT_INVALID"
    : typeof value.code === "string" ? value.code : message.split(":", 1)[0] || "SKILL_ERROR";
  return {
    isError: true,
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        code,
        message,
        ...(value.availability ? { availability: value.availability } : {}),
      }),
    }],
  };
}

export function skillPreviewResult(preview: SkillPreview) {
  const details = preview.plan.details ?? {};
  return jsonResult({
    ...preview,
    ...details,
    plan: { ...preview.plan, ...details },
  });
}
