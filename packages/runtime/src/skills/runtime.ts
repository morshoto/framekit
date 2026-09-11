import { randomUUID } from "node:crypto";
import type { ProjectService } from "../application/project-service.js";
import type { MediaAnalysisService } from "../application/media-analysis-service.js";
import type { RuntimeOptions } from "../application/runtime-options.js";
import type { ContextRevision } from "../domain/primitives.js";
import type { ProjectSnapshot } from "../domain/project.js";
import type {
  SkillDefinition,
  SkillExecution,
  SkillInputSchema,
  SkillManifest,
  SkillPlan,
  SkillPreview,
  SkillVerificationContext,
} from "../domain/skills.js";
import type { EditService } from "../editing/edit-service.js";
import { sameRevision } from "../context/revision.js";
import {
  assertSkillRequirements,
  resolveSkillRequirements,
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
  editPreviewToken?: string;
}

interface CurrentResolutionContext {
  project?: ProjectSnapshot;
  inspected: Awaited<ReturnType<ProjectService["inspectEditor"]>>;
}

export interface SkillInspection {
  manifest: SkillManifest;
  availability: SkillAvailability;
}

export class SkillRuntime {
  public readonly registry = new SkillRegistry();
  private readonly previews = new Map<string, SkillPreviewSession>();

  public constructor(
    private readonly project: ProjectService,
    private readonly analysis: MediaAnalysisService,
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

  public async listAvailability(): Promise<SkillInspection[]> {
    const context = await this.currentResolutionContext();
    return this.registry.list().map((manifest) => ({
      manifest,
      availability: resolveAvailability(manifest, context),
    }));
  }

  public async inspectAvailability(skillId: string, version?: string): Promise<SkillInspection> {
    const manifest = this.registry.inspect(skillId, version);
    const context = await this.currentResolutionContext();
    return { manifest, availability: resolveAvailability(manifest, context) };
  }

  public async preview(request: SkillPreviewRequest): Promise<SkillPreview> {
    const definition = this.registry.lookup(request.skillId, request.version);
    const before = await this.project.inspectProject();
    if (!sameRevision(request.baseRevision, before.revision)) {
      throw new Error("STALE_CONTEXT: Skill preview base revision does not match current editor state");
    }
    const inspected = await this.project.inspectEditor();
    assertSkillRequirements(definition.manifest, {
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
      analyzeSpeech: (mediaId: string, range?: import("../domain/primitives.js").TimeRange) => this.analysis.analyzeSpeech(mediaId, range),
      measureAudio: (mediaId: string, occurrenceId: string) => this.analysis.measureAudio(mediaId, occurrenceId),
      measureNoise: (mediaId: string, occurrenceId: string) => this.analysis.measureNoise(mediaId, occurrenceId),
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
      ...(planned.decision ? { decision: planned.decision } : {}),
      ...(planned.verification ? { verification: structuredClone(planned.verification) } : {}),
      ...(planned.details ? { details: structuredClone(planned.details) } : {}),
    };
    const editPreview = plan.operations.length > 0
      ? await this.edits.previewEdit({
        baseRevision: before.revision,
        operations: plan.operations,
        verification: plan.verification ?? definition.manifest.verification,
      })
      : undefined;
    const previewToken = `skill-preview-${randomUUID()}`;
    const preview: SkillPreview = {
      previewToken,
      plan,
      ...(editPreview?.expectedDiff ? { expectedDiff: editPreview.expectedDiff } : {}),
      expiresAt: editPreview?.expiresAt ?? new Date(this.now() + (this.options.previewTtlMs ?? 30_000)).toISOString(),
    };
    this.prunePreviews();
    this.previews.set(previewToken, { preview, ...(editPreview ? { editPreviewToken: editPreview.previewToken } : {}) });
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
    if (!session.editPreviewToken) {
      return {
        status: session.preview.plan.decision === "NO_OP" || !session.preview.plan.decision ? "VERIFIED" : "SKIPPED",
        plan: {
          id: session.preview.plan.id,
          skillId: session.preview.plan.skillId,
          skillVersion: session.preview.plan.skillVersion,
          baseRevision: structuredClone(session.preview.plan.baseRevision),
        },
        transactionIds: [],
        ...(session.preview.plan.details ? { details: structuredClone(session.preview.plan.details) } : {}),
        rollback: { attempted: false, succeeded: true, transactionIds: [] },
      };
    }
    const transaction = await this.edits.executeEdit(session.editPreviewToken);
    const rolledBack = transaction.status === "ROLLED_BACK";
    let verification = transaction.verification;
    let status: SkillExecution["status"] = rolledBack
      ? "ROLLED_BACK"
      : transaction.status === "VERIFIED" ? "VERIFIED" : "FAILED";
    let rollback: SkillExecution["rollback"] = {
      attempted: rolledBack,
      succeeded: rolledBack,
      transactionIds: rolledBack ? [transaction.id] : [],
    };
    if (!rolledBack && definition.handler.verify) {
      const checks = await definition.handler.verify({
        plan: session.preview.plan,
        ...(session.preview.expectedDiff ? { expectedDiff: session.preview.expectedDiff } : {}),
        transaction,
      } satisfies SkillVerificationContext);
      verification = {
        passed: Boolean(verification?.passed) && checks.every((check) => check.passed),
        checks: [...(verification?.checks ?? []), ...checks],
        ...(verification?.target ? { target: structuredClone(verification.target) } : {}),
      };
      if (!verification.passed) {
        await this.edits.undo(transaction.id);
        status = "ROLLED_BACK";
        rollback = { attempted: true, succeeded: true, transactionIds: [transaction.id] };
      }
    }
    return {
      status,
      plan: {
        id: session.preview.plan.id,
        skillId: session.preview.plan.skillId,
        skillVersion: session.preview.plan.skillVersion,
        baseRevision: structuredClone(session.preview.plan.baseRevision),
      },
      transactionIds: [transaction.id],
      diff: structuredClone(transaction.diff),
      ...(verification ? { verification: structuredClone(verification) } : {}),
      ...(session.preview.plan.details ? { details: structuredClone(session.preview.plan.details) } : {}),
      rollback,
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

  private async currentResolutionContext() {
    return { inspected: await this.project.inspectEditor() };
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

function resolveAvailability(
  manifest: SkillManifest,
  context: CurrentResolutionContext,
): SkillAvailability {
  return resolveSkillRequirements(manifest, {
    capabilities: context.inspected.capabilities,
    editor: context.inspected.identity,
    revision: context.project?.revision,
  });
}
