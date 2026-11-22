import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import type { AgentVideoRuntime, SkillPreview } from "@framekit/runtime";
import { SKILL_TOOL_METADATA, skillRevisionValueSchema, type SkillToolName } from "./metadata.js";
import { registerValidatedTool } from "../validated-tool.js";

/** Runtime capability and availability resolution stays behind this injected port. */
export type SkillToolsRuntime = Pick<AgentVideoRuntime,
  "listSkillAvailability" | "inspectSkillAvailability" | "previewSkill" | "executeSkill"
>;

const metadataByName = new Map(SKILL_TOOL_METADATA.map((metadata) => [metadata.name, metadata]));

export function registerSkillTools(server: McpServer, runtime: SkillToolsRuntime): void {
  const list = toolMetadata("skill.list");
  registerValidatedTool(server, list.name, {
    description: list.description,
    inputSchema: z.object(list.inputSchema),
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

  const inspect = toolMetadata("skill.inspect");
  registerValidatedTool(server, inspect.name, {
    description: inspect.description,
    inputSchema: z.object(inspect.inputSchema),
  }, async ({ skill, version }) => {
    try {
      const { manifest, availability } = await runtime.inspectSkillAvailability(skill, version);
      return jsonResult({ ...manifest, availability });
    } catch (error) {
      return skillErrorResult(error);
    }
  });

  const preview = toolMetadata("skill.preview");
  registerValidatedTool(server, preview.name, {
    description: preview.description,
    inputSchema: z.object(preview.inputSchema),
  }, async ({ skill, version, arguments: skillArguments }) => {
    try {
      const baseRevision = skillRevisionValueSchema.parse(skillArguments.baseRevision);
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

  const execute = toolMetadata("skill.execute");
  registerValidatedTool(server, execute.name, {
    description: execute.description,
    inputSchema: z.object(execute.inputSchema),
  }, async ({ previewToken }) => {
    try {
      return jsonResult(await runtime.executeSkill(previewToken));
    } catch (error) {
      return skillErrorResult(error);
    }
  });
}

function toolMetadata<Name extends SkillToolName>(name: Name): Extract<(typeof SKILL_TOOL_METADATA)[number], { name: Name }> {
  const metadata = metadataByName.get(name);
  if (!metadata) throw new Error(`SKILL_TOOL_METADATA_MISSING: ${name}`);
  return metadata as Extract<(typeof SKILL_TOOL_METADATA)[number], { name: Name }>;
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
