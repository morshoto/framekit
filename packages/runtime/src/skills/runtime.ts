import { randomUUID } from "node:crypto";
import type { ProjectService } from "../application/project-service.js";
import type { RuntimeOptions } from "../application/runtime-options.js";
import type { ContextRevision } from "../domain/primitives.js";
import type {
  SkillDefinition,
  SkillExecution,
  SkillInputSchema,
  SkillManifest,
  SkillPlan,
  SkillPreview,
} from "../domain/skills.js";
import type { EditService } from "../editing/edit-service.js";
import { sameRevision } from "../context/revision.js";
import {
  assertSkillRequirements,
  type SkillAvailability,
} from "./requirements.js";
import { SkillRegistry } from "./registry.js";

export interface SkillPreviewRequest {
  skillId: string;
  version?: string;
  baseRevision: ContextRevision;
  input: unknown;
}

interface SkillPreviewSession {
  preview: SkillPreview;
  editPreviewToken: string;
}

export class SkillRuntime {
  public readonly registry = new SkillRegistry();
  private readonly previews = new Map<string, SkillPreviewSession>();

  public constructor(
    private readonly project: ProjectService,
    private readonly edits: EditService,
    private readonly options: RuntimeOptions = {},
  ) {}

  public register(definition: SkillDefinition): void {
    this.registry.register(definition);
  }

  public list(): SkillManifest[] {
    return this.registry.list();
  }

  public inspect(skillId: string, version?: string): SkillManifest {
    return this.registry.inspect(skillId, version);
  }

  public async preview(request: SkillPreviewRequest): Promise<SkillPreview> {
    const definition = this.registry.lookup(request.skillId, request.version);
    const before = await this.project.inspectProject();
    if (!sameRevision(request.baseRevision, before.revision)) {
      throw new Error("STALE_CONTEXT: Skill preview base revision does not match current editor state");
    }
    const inspected = await this.project.inspectEditor();
    const availability = assertSkillRequirements(definition.manifest, {
      capabilities: inspected.capabilities,
      editor: inspected.identity,
      revision: before.revision,
    });
    this.assertInputSchema(definition.manifest.inputSchema, request.input);
    const normalizedInput = await normalizeInput(definition, request.input);
    const handlerContext = Object.freeze({
      project: structuredClone(before),
      capabilities: structuredClone(inspected.capabilities),
      baseRevision: structuredClone(before.revision),
    });
    const planned = await definition.handler.plan(handlerContext, normalizedInput);
    const plan: SkillPlan = {
      id: `plan-${randomUUID()}`,
      skillId: definition.manifest.id,
      skillVersion: definition.manifest.version,
      baseRevision: structuredClone(before.revision),
      normalizedInput: structuredClone(normalizedInput),
      operations: structuredClone(planned.operations),
      affectedRanges: structuredClone(planned.affectedRanges),
      warnings: [...planned.warnings],
    };
    if (plan.operations.length === 0) throw new Error("SKILL_PLAN_INVALID: at least one semantic operation is required");
    const editPreview = await this.edits.previewEdit({
      baseRevision: before.revision,
      operations: plan.operations,
      verification: definition.manifest.verification,
    });
    const previewToken = `skill-preview-${randomUUID()}`;
    const preview: SkillPreview = {
      previewToken,
      plan,
      expectedDiff: editPreview.expectedDiff,
      expiresAt: editPreview.expiresAt,
    };
    this.prunePreviews();
    this.previews.set(previewToken, { preview, editPreviewToken: editPreview.previewToken });
    return structuredClone(preview);
  }

  public async execute(previewToken: string): Promise<SkillExecution> {
    const session = this.previews.get(previewToken);
    if (!session) throw new Error(`SKILL_PREVIEW_TOKEN_INVALID: unknown or already used preview ${previewToken}`);
    this.previews.delete(previewToken);
    if (this.now() > Date.parse(session.preview.expiresAt)) {
      throw new Error("SKILL_PREVIEW_TOKEN_EXPIRED: Skill preview has expired");
    }
    const definition = this.registry.lookup(session.preview.plan.skillId, session.preview.plan.skillVersion);
    const before = await this.project.inspectProject();
    if (!sameRevision(session.preview.plan.baseRevision, before.revision)) {
      throw new Error("STALE_CONTEXT: Skill preview base revision does not match current editor state");
    }
    const inspected = await this.project.inspectEditor();
    assertSkillRequirements(definition.manifest, {
      capabilities: inspected.capabilities,
      editor: inspected.identity,
      revision: before.revision,
    });
    const transaction = await this.edits.executeEdit(session.editPreviewToken);
    const rolledBack = transaction.status === "ROLLED_BACK";
    return {
      status: rolledBack ? "ROLLED_BACK" : transaction.status === "VERIFIED" ? "VERIFIED" : "FAILED",
      plan: {
        id: session.preview.plan.id,
        skillId: session.preview.plan.skillId,
        skillVersion: session.preview.plan.skillVersion,
        baseRevision: structuredClone(session.preview.plan.baseRevision),
      },
      transactionIds: [transaction.id],
      ...(transaction.verification ? { verification: structuredClone(transaction.verification) } : {}),
      rollback: {
        attempted: rolledBack,
        succeeded: rolledBack,
        transactionIds: rolledBack ? [transaction.id] : [],
      },
    };
  }

  private assertInputSchema(schema: SkillInputSchema, input: unknown): asserts input is Record<string, unknown> {
    if (!isRecord(input)) throw new Error("SKILL_INPUT_INVALID: input must be an object");
    for (const required of schema.required ?? []) {
      if (!(required in input)) throw new Error(`SKILL_INPUT_INVALID: missing required input ${required}`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(input)) {
        if (!(key in schema.properties)) throw new Error(`SKILL_INPUT_INVALID: unknown input ${key}`);
      }
    }
    for (const [key, property] of Object.entries(schema.properties)) {
      if (key in input) validateSchemaValue(property, input[key], key);
    }
  }

  private prunePreviews(): void {
    const now = this.now();
    for (const [token, session] of this.previews) {
      if (now > Date.parse(session.preview.expiresAt)) this.previews.delete(token);
    }
    const limit = Number.isInteger(this.options.maxActivePreviews) && this.options.maxActivePreviews! > 0
      ? this.options.maxActivePreviews!
      : 128;
    while (this.previews.size >= limit) {
      const oldest = this.previews.keys().next().value;
      if (oldest === undefined) break;
      this.previews.delete(oldest);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

async function normalizeInput(definition: SkillDefinition, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const normalized = await definition.handler.normalize(input);
    if (!isRecord(normalized)) throw new Error("normalized input must be an object");
    return normalized;
  } catch (error) {
    throw new Error(`SKILL_INPUT_INVALID: ${String(error)}`);
  }
}

function validateSchemaValue(schema: SkillInputSchema["properties"][string], value: unknown, path: string): void {
  if (schema.type === "object") {
    if (!isRecord(value)) throw new Error(`SKILL_INPUT_INVALID: ${path} must be an object`);
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`SKILL_INPUT_INVALID: ${path} must be an array`);
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`SKILL_INPUT_INVALID: ${path} has too few items`);
    value.forEach((item, index) => validateSchemaValue(schema.items, item, `${path}[${index}]`));
    return;
  }
  const valid = schema.type === "string"
    ? typeof value === "string"
    : schema.type === "boolean"
      ? typeof value === "boolean"
      : typeof value === "number" && Number.isFinite(value) && (schema.type !== "integer" || Number.isInteger(value));
  if (!valid) throw new Error(`SKILL_INPUT_INVALID: ${path} has type ${schema.type}`);
  if (schema.type === "string" && schema.minLength !== undefined && (value as string).length < schema.minLength) {
    throw new Error(`SKILL_INPUT_INVALID: ${path} is too short`);
  }
  if ((schema.type === "number" || schema.type === "integer") && schema.minimum !== undefined && (value as number) < schema.minimum) {
    throw new Error(`SKILL_INPUT_INVALID: ${path} is below minimum`);
  }
  if ((schema.type === "number" || schema.type === "integer") && schema.maximum !== undefined && (value as number) > schema.maximum) {
    throw new Error(`SKILL_INPUT_INVALID: ${path} is above maximum`);
  }
  if (schema.type === "string" && schema.enum && !schema.enum.includes(value as string)) {
    throw new Error(`SKILL_INPUT_INVALID: ${path} is not an allowed value`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
